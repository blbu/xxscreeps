import * as C from 'xxscreeps/game/constants';
import { RoomPosition } from 'xxscreeps/game/position';
import { Creep } from 'xxscreeps/mods/creep/creep';
import { assert, describe, simulate, test } from 'xxscreeps/test';
import { create } from './spawn';

describe('Spawn', () => {
	const simulation = simulate({
		W1N1: room => {
			room['#insertObject'](create(new RoomPosition(25, 25, 'W1N1'), '100', 'Spawn1'));
			room['#level'] = 1;
			room['#user'] =
			room.controller!['#user'] = '100';
		},
	});

	test('spawn direction', () => simulation(async({ player, tick }) => {
		await player('100', Game => {
			Game.spawns.Spawn1.spawnCreep([ C.MOVE ], 'creep', {
				directions: [ C.RIGHT ],
			});
		});
		await tick(3);
		await player('100', Game => {
			assert.ok(Game.creeps.creep.pos.isEqualTo(26, 25));
		});
	}));

	test('set direction', () => simulation(async({ player, tick }) => {
		await player('100', Game => {
			Game.spawns.Spawn1.spawnCreep([ C.MOVE ], 'creep');
		});
		await tick();
		await player('100', Game => {
			Game.spawns.Spawn1.spawning?.setDirections([ C.BOTTOM ]);
		});
		await tick(2);
		await player('100', Game => {
			assert.ok(Game.creeps.creep.pos.isEqualTo(25, 26));
		});
	}));

	test('cancel spawn', () => simulation(async({ player, tick }) => {
		await player('100', Game => {
			Game.spawns.Spawn1.spawnCreep([ C.MOVE ], 'creep');
		});
		await tick();
		await player('100', Game => {
			Game.spawns.Spawn1.spawning!.cancel();
		});
		await tick();
		await player('100', Game => {
			assert.ok(!Game.spawns.spawning);
			assert.strictEqual(Game.rooms.W1N1['#objects'].some(object => object instanceof Creep), false);
		});
	}));
});
