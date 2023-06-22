import type { CPU } from 'xxscreeps/game/game.js';
import type { Compiler, Evaluate } from 'xxscreeps/driver/runtime/index.js';
import type { InitializationPayload, TickPayload } from 'xxscreeps/engine/runner/index.js';
import * as Runtime from 'xxscreeps/driver/runtime/index.js';
import { hooks } from 'xxscreeps/game/index.js';
export { tick } from 'xxscreeps/driver/runtime/index.js';

export let process: typeof import('process');

class NodejsCPU implements CPU {
	bucket;
	limit;
	tickLimit;
	#startTime;

	constructor(data: TickPayload) {
		this.bucket = data.cpu.bucket;
		this.limit = data.cpu.limit;
		this.tickLimit = data.cpu.tickLimit;
		this.#startTime = process.hrtime.bigint();
	}

	getHeapStatistics = () => ({} as never);

	getUsed = () => Number(process.hrtime.bigint() - this.#startTime) / 1e6;

	halt = (): never => {
		throw new Error('Cannot halt()');
	};
}

hooks.register('gameInitializer', (game, data) => {
	game.cpu = new NodejsCPU(data!);
});

export function initialize(require: NodeRequire, compiler: Compiler, evaluate: Evaluate, data: InitializationPayload) {
	process = require('process');
	Runtime.initialize(compiler, evaluate, data);
}
