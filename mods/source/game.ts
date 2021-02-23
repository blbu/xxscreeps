import * as C from 'xxscreeps/game/constants';
import { lookFor, registerFindHandlers, registerLook } from 'xxscreeps/game/room';
import { registerHarvestable } from 'xxscreeps/mods/harvestable';
import { Source } from './source';

// Register FIND_ types for `Source`
const find = registerFindHandlers({
	[C.FIND_SOURCES]: room =>
		lookFor(room, C.LOOK_SOURCES),
	[C.FIND_SOURCES_ACTIVE]: room =>
		lookFor(room, C.LOOK_SOURCES).filter(source => source.energy > 0),
});

// Register LOOK_ type for `Source`
const look = registerLook<Source>()(C.LOOK_SOURCES);
declare module 'xxscreeps/game/room' {
	interface Find { source: typeof find }
	interface Look { source: typeof look }
}

// Register `Creep.harvest` target
const harvest = registerHarvestable(Source, function(creep) {
	if (creep.getActiveBodyparts(C.WORK) <= 0) {
		return C.ERR_NO_BODYPART;
	} else if (!creep.pos.isNearTo(this.pos)) {
		return C.ERR_NOT_IN_RANGE;
	}

	if (this.energy <= 0) {
		return C.ERR_NOT_ENOUGH_RESOURCES;
	}
	return C.OK;
});
declare module 'xxscreeps/mods/harvestable' {
	interface Harvest { source: typeof harvest }
}
