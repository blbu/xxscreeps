import { BufferView } from './buffer-view';
const { isArray } = Array;
const { entries, values } = Object;

// This specifies memory layout in a hopefully stable format
export type Integral = 'int8' | 'int16' | 'int32' | 'uint8' | 'uint16' | 'uint32';

type StructMember = {
	layout: Layout;
	offset: number;
	pointer?: true;
};

export type StructLayout = {
	[key: string]: StructMember;
};

type ArrayLayout = [ 'array', number, Layout ];
type VectorLayout = [ 'vector', Layout ];

export type Layout = Integral | StructLayout | ArrayLayout | VectorLayout;

export type Traits = {
	align: number;
	size: number;
	stride?: number;
};

// Convert a memory layout declaration to the corresponding data type
type ArrayShape<Type extends ArrayLayout> = Shape<Type[2]>[];
type VectorShape<Type extends VectorLayout> = Shape<Type[1]>[];
type StructShape<Type extends StructLayout> = {
	[Key in keyof Type]: Shape<Type[Key]['layout']>;
};
type Shape<Type extends Layout> =
	Type extends Integral ? number :
	Type extends ArrayLayout ? ArrayShape<Type> :
	Type extends VectorLayout ? VectorShape<Type> :
	Type extends StructLayout ? StructShape<Type> : never;

export const kPointerSize = 4;

export function alignTo(address: number, align: number) {
	const remainder = address % align;
	return address + (remainder === 0 ? 0 : align - remainder);
}

export function getTraits(layout: Layout): Traits {
	if (typeof layout === 'string') {
		// Integral types
		const integerTraits = (sizeof: number) =>
			({ align: sizeof, size: sizeof, stride: sizeof });
		switch (layout) {
			case 'int8': return integerTraits(1);
			case 'int16': return integerTraits(2);
			case 'int32': return integerTraits(4);

			case 'uint8': return integerTraits(1);
			case 'uint16': return integerTraits(2);
			case 'uint32': return integerTraits(4);

			default: throw TypeError(`Invalid literal layout: ${layout}`);
		}

	} else if (isArray(layout)) {
		if (layout[0] === 'array') {
			// Fixed size array
			const length = layout[1];
			const traits = getTraits(layout[2]);
			return {
				align: traits.align,
				size: traits.size * length,
				...traits.stride && {
					stride: traits.stride * (length - 1) + traits.size,
				},
			};

		} else if (layout[0] === 'vector') {
			// Dynamic vector
			const traits = getTraits(layout[1]);
			return {
				align: Math.max(kPointerSize, traits.align),
				size: kPointerSize,
			};
		}
		throw TypeError(`Invalid array type: ${layout[0]}`);

	} else {
		// Structures
		const members = values(layout).map(member => ({
			...member,
			traits: getTraits(member.layout),
		}));
		const traits: Traits = {
			align: Math.max(...members.map(member =>
				Math.max(member.pointer ? kPointerSize : 0, member.traits.align)
			)),
			size: Math.max(...members.map(member =>
				member.offset + (member.pointer ? kPointerSize : member.traits.size)
			)),
		};
		const hasPointerElement = members.some(member => member.pointer);
		if (!hasPointerElement) {
			traits.stride = alignTo(traits.size, traits.size);
		}
		return traits;
	}
}

export function getWriter<Type extends Layout>(layout: Type):
		(value: Shape<Type>, view: BufferView, offset: number) => number
export function getWriter(layout: Layout):
		(value: any, view: BufferView, offset: number) => number {

	if (typeof layout === 'string') {
		// Integral types
		switch (layout) {
			case 'int8': return (value, view, offset) => (view.int8[offset] = value, 1);
			case 'int16': return (value, view, offset) => (view.int16[offset >>> 1] = value, 2);
			case 'int32': return (value, view, offset) => (view.int32[offset >>> 2] = value, 4);

			case 'uint8': return (value, view, offset) => (view.uint8[offset] = value, 1);
			case 'uint16': return (value, view, offset) => (view.uint16[offset >>> 1] = value, 2);
			case 'uint32': return (value, view, offset) => (view.uint32[offset >>> 2] = value, 4);

			default: throw TypeError(`Invalid literal layout: ${layout}`);
		}

	} else if (isArray(layout)) {
		// Array types
		if (layout[0] === 'array') {
			const elementLayout = layout[2];
			const write = getWriter(elementLayout);
			const { size, stride } = getTraits(elementLayout);
			if (stride === undefined) {
				throw new TypeError('Unimplemented');

			} else {
				// Array with fixed element size
				const length = layout[1];
				return (value, view, offset) => {
					let currentOffset = offset;
					write(value[0], view, currentOffset);
					for (let ii = 1; ii < length; ++ii) {
						currentOffset += stride;
						write(value[ii], view, currentOffset);
					}
					return currentOffset + size - offset;
				};
			}

		} else if (layout[0] === 'vector') {
			const elementLayout = layout[1];
			const write = getWriter(elementLayout);
			const { align, size, stride } = getTraits(elementLayout);
			if (stride === undefined) {
				throw new TypeError('Unimplemented');

			} else {
				// Vector with fixed element size
				return (value, view, offset) => {
					const length: number = value.length;
					let currentOffset = alignTo(offset, kPointerSize);
					view.uint32[currentOffset >>> 2] = length; // write total length of vector
					currentOffset += kPointerSize;
					if (length !== 0) {
						currentOffset = alignTo(currentOffset, align);
						write(value[0], view, currentOffset);
						for (let ii = 1; ii < length; ++ii) {
							currentOffset += stride;
							write(value[ii], view, currentOffset);
						}
						currentOffset += size;
					}
					return currentOffset - offset;
				};
			}
		}
		throw new TypeError('Invalid layout');

	} else {
		// Structures
		let memberWriter: ((value: any, view: BufferView, offset: number, locals: number) => any) | undefined;
		const members = entries(layout);
		members.forEach(([ key, member ]) => {
			// Make writer for single field. Extra parameter is offset to dynamic memory.
			const next = function(): NonNullable<typeof memberWriter> {
				const write = getWriter(member.layout);
				const { offset, pointer } = member;
				if (pointer) {
					const { align } = getTraits(layout);
					return (value, view, instanceOffset, locals) => {
						const addr = alignTo(locals, align);
						view.uint32[(offset + instanceOffset) >>> 2] = addr;
						return locals + write(value[key], view, locals);
					};
				} else {
					return (value, view, instanceOffset, locals) =>
						(write(value[key], view, offset + instanceOffset), locals);
				}
			}();
			// Combine member writers
			const prev = memberWriter;
			if (prev) {
				memberWriter = (value, view, offset, locals) =>
					next(value, view, offset, prev(value, view, offset, locals));
			} else {
				memberWriter = next;
			}
		});
		// Wrap member writers into struct writer
		const { size } = getTraits(layout);
		return (value, view, offset) => memberWriter!(value, view, offset, size);
	}
}
