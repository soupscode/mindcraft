// Genesis: homes. DECIDED: an agent lives in its finished home. Once the home is verified
//   - the agent shelters and sleeps there: its home point (genesis/town/client.js, townZones.home) is
//     the home's bed place. Its RANGE stays centred on the camp.
//   - it places its bed as furniture in the cells the prefab keeps clear for it (the catalog's
//     furnish_home goal; the bed is an item the agent holds: see the open decision on where beds come from)
//   - it keeps a personal chest there: the chest the home's prefab holds (the same cell of the plot in
//     every home tier, so an upgrade never breaks it). Personal storage moves home; the shared chest
//     stays for the town's supplies.
// Everyone builds and upgrades their own home; a home tier that is verified on the agent's plot becomes
// where it lives, and the tier before it is what the upgrade may take down.
//
// This file keeps town.homes in step with the verified builds. Nothing here touches the world.
//
// Depends only on other files of genesis/town and genesis/build.

export const homeChestName = (agent) => `home-${agent}`;

// Where the pieces of a home are in the world, for a prefab standing on a plot (plots of homes are not turned).
export function homePlaces(plot, prefab) {
    const below = Number.isInteger(prefab.below) ? prefab.below : 0;
    const at = ([x, y, z]) => [plot.min[0] + x, plot.min[1] - below + y, plot.min[2] + z];
    const chest = (prefab.keeps ?? []).find((keep) => keep.block === 'chest') ?? null;
    return {
        bed: prefab.bed ? { head: at(prefab.bed.head), foot: at(prefab.bed.foot) } : null,
        chest: chest ? at(chest.at) : null,
        // where the agent stands when it is at home: the foot of its bed place, else the middle of the home
        shelter: prefab.bed ? at(prefab.bed.foot) : at([Math.floor((prefab.size?.x ?? 1) / 2), below, Math.floor((prefab.size?.z ?? 1) / 2)]),
    };
}

export function createHomes({ town, zones_config, prefabs, clock = { now: Date.now } } = {}) {
    void clock;
    const plots = () => [...(zones_config.plots ?? []), ...town.state().plots];
    // A verified home build: the builder lives there now.
    function moved(build) {
        const prefab = prefabs.get(build.prefab);
        const plot = plots().find((p) => p.id === build.plot) ?? null;
        if (!prefab || prefab.kind !== 'home' || !plot || plot.owner !== build.builder) return false;
        const places = homePlaces(plot, prefab);
        const before = town.state().homes[build.builder] ?? null;
        // the bed stays placed when its place did not move (shack to cabin); it is taken along when it did
        const same_bed = before?.bed && places.bed && JSON.stringify([before.bed.head, before.bed.foot]) === JSON.stringify([places.bed.head, places.bed.foot]);
        const home = {
            plot: plot.id, prefab: prefab.name, title: prefab.title ?? prefab.name, tier: prefab.tier, verified_at: build.verified_at, verified_day: build.verified_day ?? null,
            shelter: places.shelter, bed: places.bed ? { ...places.bed, placed: same_bed ? before.bed.placed === true : false } : null,
            chest: places.chest, chest_name: places.chest ? homeChestName(build.builder) : null,
        };
        town.update((t) => { t.homes[build.builder] = home; }, 'home_changed', { agent: build.builder, ...home }, build.builder);
        return true;
    }
    const stop = town.onChange((what, detail) => { if (what === 'build_verified' && detail?.kind === 'home') moved(detail); });
    return { moved, stop, homePlaces };
}
