import { BufferView } from './buffer-view';
import { Variant } from './format';
import type { BoundInterceptorSchema } from './interceptor';
import { kPointerSize, alignTo, getTraits, Layout, StructLayout } from './layout';
import { RecursiveWeakMemoize } from '~/lib/memoize';

type Writer<Type = any> = (value: Type, view: BufferView, offset: number) => number;
type MemberWriter = (value: any, view: BufferView, offset: number, locals: number) => number;

const getMemberWriter = RecursiveWeakMemoize([ 0, 1 ],
	(layout: StructLayout, interceptorSchema: BoundInterceptorSchema): MemberWriter => {

		let writeMembers: MemberWriter | undefined;
		const interceptors = interceptorSchema.get(layout);
		for (const [ key, member ] of Object.entries(layout.struct)) {
			const symbol = interceptors?.members?.[key]?.symbol ?? key;

			// Make writer for single field. `locals` parameter is offset to dynamic memory.
			const next = function(): MemberWriter {
				// Get writer for this member
				const { offset, pointer } = member;
				const write = function(): Writer {
					const write = getTypeWriter(member.layout, interceptorSchema);

					// Has decomposer?
					const decompose = interceptors?.members?.[key]?.decompose;
					if (decompose !== undefined) {
						return (value, view, offset) => write(decompose(value), view, offset);
					}
					const decomposeIntoBuffer = interceptors?.members?.[key]?.decomposeIntoBuffer;
					if (decomposeIntoBuffer !== undefined) {
						if (pointer === true) {
							throw new Error('Pointer to raw decomposer is not supported');
						}
						return (value, view, offset) => decomposeIntoBuffer(value, view, offset);
					}

					// Plain writer
					return write;
				}();

				// Wrap to write this field at reserved address
				if (pointer === true) {
					const { align } = getTraits(layout);
					return (value, view, instanceOffset, locals) => {
						const addr = alignTo(locals, align);
						view.uint32[instanceOffset + offset >>> 2] = addr;
						return addr + write(value[symbol], view, addr);
					};
				} else {
					return (value, view, instanceOffset, locals) =>
						((write(value[symbol], view, instanceOffset + offset), locals));
				}
			}();

			// Combine member writers
			const prev = writeMembers;
			if (prev === undefined) {
				writeMembers = next;
			} else {
				writeMembers = (value, view, offset, locals) =>
					next(value, view, offset, prev(value, view, offset, locals));
			}
		}

		// Run inheritance recursively
		const { inherit } = layout;
		if (inherit === undefined) {
			return writeMembers!;
		} else {
			const writeBase = getMemberWriter(inherit, interceptorSchema);
			return (value, view, offset, locals) =>
				writeMembers!(value, view, offset, writeBase(value, view, offset, locals));
		}
	});

const getTypeWriter = RecursiveWeakMemoize([ 0, 1 ], (layout: Layout, interceptorSchema: BoundInterceptorSchema): Writer => {

	if (typeof layout === 'string') {
		// Integral types
		switch (layout) {
			case 'int8': return (value, view, offset) => ((view.int8[offset] = value, 1));
			case 'int16': return (value, view, offset) => ((view.int16[offset >>> 1] = value, 2));
			case 'int32': return (value, view, offset) => ((view.int32[offset >>> 2] = value, 4));

			case 'uint8': return (value, view, offset) => ((view.uint8[offset] = value, 1));
			case 'uint16': return (value, view, offset) => ((view.uint16[offset >>> 1] = value, 2));
			case 'uint32': return (value, view, offset) => ((view.uint32[offset >>> 2] = value, 4));

			case 'bool': return (value: boolean, view, offset) => ((view.int8[offset] = value ? 1 : 0, 1));

			case 'string': return (value: string, view, offset) => {
				// Write string length
				const { length } = value;
				view.uint32[offset >>> 2] = length;
				// Write string data
				const stringOffset = offset + kPointerSize >>> 1;
				const { uint16 } = view;
				for (let ii = 0; ii < length; ++ii) {
					uint16[stringOffset + ii] = value.charCodeAt(ii);
				}
				return (length << 1) + kPointerSize;
			};

			default: throw TypeError(`Invalid literal layout: ${layout}`);
		}
	}

	// Fetch reader for non-literal type
	const write = function(): Writer {
		if ('array' in layout) {
			// Array types
			const arraySize = layout.size;
			const elementLayout = layout.array;
			const write = getTypeWriter(elementLayout, interceptorSchema);
			const { size, stride } = getTraits(elementLayout);
			if (stride === undefined) {
				throw new TypeError('Unimplemented');

			} else {
				// Array with fixed element size
				return (value, view, offset) => {
					let currentOffset = offset;
					write(value[0], view, currentOffset);
					for (let ii = 1; ii < arraySize; ++ii) {
						currentOffset += stride;
						write(value[ii], view, currentOffset);
					}
					return size;
				};
			}

		} else if ('enum' in layout) {
			// Enumerated types
			const enumMap = new Map(layout.enum.map((value, ii) => [ value, ii ]));
			return (value, view, offset) => ((view.uint8[offset] = enumMap.get(value)!, 1));

		} else if ('optional' in layout) {
			// Optional types
			const elementLayout = layout.optional;
			const write = getTypeWriter(elementLayout, interceptorSchema);
			const { align, size, stride } = getTraits(elementLayout);
			if (stride === undefined) {
				// Dynamic size element. Flag is pointer to memory (just 4 bytes ahead)
				return (value, view, offset) => {
					if (value === undefined) {
						view.uint32[offset >>> 2] = 0;
						return kPointerSize;
					} else {
						const addr = view.uint32[offset >>> 2] = alignTo(offset + kPointerSize, align);
						return write(value, view, addr) + kPointerSize;
					}
				};
			} else {
				// Fixed size element. Flag is 1 byte at end of structure.
				const sizePlusOne = size + 1;
				return (value, view, offset) => {
					if (value === undefined) {
						// Zero out the memory, including the flag
						const end = offset + sizePlusOne;
						for (let ii = offset; ii < end; ++ii) {
							view.int8[ii] = 0;
						}
						return sizePlusOne;
					} else {
						view.uint8[size] = 1;
						return write(value, view, offset) + 1;
					}
				};
			}

		} else if ('variant' in layout) {
			// Variant types
			const variantMap = new Map<string, Writer>();
			for (let ii = 0; ii < layout.variant.length; ++ii) {
				const elementLayout = layout.variant[ii];
				const write = getTypeWriter(elementLayout, interceptorSchema);
				variantMap.set(
					elementLayout[Variant]!,
					(value, view, offset) => {
						view.uint32[offset >>> 2] = ii;
						return kPointerSize + write(value, view, offset + kPointerSize);
					},
				);
			}
			return (value, view, offset) => variantMap.get(value[Variant])!(value, view, offset);

		} else if ('vector' in layout) {
			const elementLayout = layout.vector;
			const write = getTypeWriter(elementLayout, interceptorSchema);
			const { size, stride } = getTraits(elementLayout);
			if (stride === undefined) {
				// Vector with dynamic element size
				return (value, view, offset) => {
					let length = 0;
					let currentOffset = offset + kPointerSize;
					for (const element of value) {
						++length;
						const elementOffset = currentOffset + kPointerSize;
						const size = alignTo(write(element, view, elementOffset), kPointerSize);
						currentOffset = view.uint32[currentOffset >>> 2] = elementOffset + size;
					}
					view.uint32[offset >>> 2] = length;
					return currentOffset - offset;
				};

			} else {
				// Vector with fixed element size
				return (value, view, offset) => {
					let length = 0;
					let currentOffset = offset + kPointerSize;
					for (const element of value) {
						++length;
						write(element, view, currentOffset);
						currentOffset += stride;
					}
					view.uint32[offset >>> 2] = length;
					// Final element is `size` instead of `stride` because we don't need to align the next
					// element
					return currentOffset - offset + size - stride;
				};
			}

		} else {
			// Structures
			const { size } = getTraits(layout);
			const writeMembers = getMemberWriter(layout, interceptorSchema);
			return (value, view, offset) => writeMembers(value, view, offset, offset + size) - offset;
		}
	}();

	// Has decomposer?
	const interceptors = interceptorSchema.get(layout);
	const decompose = interceptors?.decompose;
	if (decompose !== undefined) {
		return (value, view, offset) => write(decompose(value), view, offset);
	}
	const decomposeIntoBuffer = interceptors?.decomposeIntoBuffer;
	if (decomposeIntoBuffer !== undefined) {
		return (value, view, offset) => decomposeIntoBuffer(value, view, offset);
	}
	return write;
});

export function getWriter<Layout>(layout: Layout, interceptorSchema: BoundInterceptorSchema) {
	const write = getTypeWriter(layout as any, interceptorSchema);
	return (value: Layout, buffer: Uint8Array) => {
		const view = BufferView.fromTypedArray(buffer);
		return write(value, view, 0);
	};
}