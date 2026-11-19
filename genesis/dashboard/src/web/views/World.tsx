// The World view: the site, the zones and the plots as the world file has them, and the
// summary of the bootstrap manifest (how the site was chosen, how it was levelled, what the
// operator placed, what favours the agents). All of it comes from two events under the name
// "world" (genesis/world/announce.js); nothing is shown that they do not say.

import { useClient } from '../store';
import { clockTime } from '../format';
import { NotConnected } from '../ui';

const at = (p: unknown) => (Array.isArray(p) ? p.join(', ') : '?');
const box = (b: any) => (b ? `${at(b.min)} to ${at(b.max)}` : '?');

export function World() {
    const { live } = useClient();
    const zones = live.world.zones;
    const boot = live.world.bootstrap;
    if (!zones && !boot) {
        return <NotConnected what="World" missing="No world event has arrived yet. The launcher emits the site and the bootstrap summary when it starts with planning and events on." />;
    }
    const site = boot?.site ?? null;
    return (
        <>
            {zones && (
                <section class="panel tint stack" aria-label="Site">
                    <div class="between"><h2 class="title">Site</h2><span class="small muted">{live.world.zones_at ? clockTime(live.world.zones_at) : ''}</span></div>
                    <dl class="facts">
                        <div><dt>Home</dt><dd class="mono">{at(zones.home)}</dd></div>
                        <div><dt>Floor</dt><dd class="mono">y {zones.floor_y}</dd></div>
                        <div><dt>Seed</dt><dd class="mono">{zones.seed}</dd></div>
                        <div><dt>Border</dt><dd class="mono">{zones.border?.size} at {at(zones.border?.center)}</dd></div>
                        <div><dt>Land</dt><dd class="mono">{box(zones.land)}</dd></div>
                    </dl>
                </section>
            )}
            <main class="cards">
                {zones && (
                    <article class="panel stack" aria-label="Zones">
                        <h2 class="title">Zones</h2>
                        <table class="grid">
                            <thead><tr><th>Zone</th><th>Owner</th><th>From, to</th></tr></thead>
                            <tbody>
                                <tr><td>Camp</td><td class="muted">all</td><td class="mono">{box(zones.camp)}</td></tr>
                                <tr><td>Field</td><td>{zones.field?.owner ?? <span class="muted">all</span>}</td><td class="mono">{box(zones.field)}</td></tr>
                                {(zones.plots ?? []).map((plot: any) => (
                                    <tr><td>Plot {plot.id}{plot.blueprint ? <span class="small muted"> · {plot.blueprint}</span> : null}</td><td>{plot.owner ?? <span class="muted">spare</span>}</td><td class="mono">{at(plot.min)} to {at(plot.max)}</td></tr>
                                ))}
                                {Object.entries(zones.chests ?? {}).map(([name, pos]) => <tr><td>Chest {name}</td><td class="muted">all</td><td class="mono">{at(pos)}</td></tr>)}
                            </tbody>
                        </table>
                        <table class="grid">
                            <thead><tr><th>Agent</th><th>Home</th><th>Range</th></tr></thead>
                            <tbody>{Object.entries(zones.agents ?? {}).map(([name, entry]: [string, any]) => <tr><td>{name}</td><td class="mono">{at(entry.home)}</td><td class="mono">{entry.range}</td></tr>)}</tbody>
                        </table>
                    </article>
                )}
                {boot && (
                    <article class={boot.verified ? 'panel stack' : 'panel stack fail'} aria-label="Bootstrap">
                        <div class="between"><h2 class="title">Bootstrap</h2><span class={boot.verified ? 'tag' : 'tag fail'}>{boot.verified ? 'Verified' : 'Not verified'}</span></div>
                        <dl class="facts">
                            <div><dt>By</dt><dd>{boot.attributed_to}</dd></div>
                            <div><dt>Runs</dt><dd>{boot.runs}</dd></div>
                            <div><dt>Verified</dt><dd>{boot.verified_at ? clockTime(boot.verified_at) : 'never'}</dd></div>
                            <div><dt>World file</dt><dd>{boot.world_matches === false ? <span style="color:var(--crimson)">changed since</span> : 'matches'}</dd></div>
                            <div><dt>Blocks placed</dt><dd>{boot.blocks_placed}</dd></div>
                            <div><dt>Item stacks</dt><dd>{boot.items_placed}</dd></div>
                        </dl>
                        {site && (
                            <section class="stack" style="gap:6px">
                                <div class="label">Site choice <span class="plain">{site.method}</span></div>
                                <dl class="facts">
                                    <div><dt>Home</dt><dd class="mono">{at(site.home)}</dd></div>
                                    {site.candidates && <div><dt>Places passed</dt><dd>{site.candidates.passed} / {site.candidates.total}</dd></div>}
                                    {site.exact && <div><dt>To level</dt><dd>{site.exact.changes} blocks</dd></div>}
                                    {site.distance_from_spawn !== undefined && <div><dt>From spawn</dt><dd>{site.distance_from_spawn}</dd></div>}
                                    {site.commands && <div><dt>Commands</dt><dd>{site.commands}</dd></div>}
                                </dl>
                            </section>
                        )}
                        <section class="stack" style="gap:6px">
                            <div class="label">Levelling <span class="plain">{boot.levelling?.blocks_changed ?? 0} blocks</span></div>
                            <table class="grid">
                                <thead><tr><th>Zone</th><th>Cleared</th><th>Floored</th></tr></thead>
                                <tbody>{(boot.levelling?.zones ?? []).map((zone: any) => <tr><td>{zone.zone}</td><td class="mono">{zone.cleared}</td><td class="mono">{zone.floored}</td></tr>)}</tbody>
                            </table>
                        </section>
                        <section class="stack" style="gap:6px">
                            <div class="label">Favours the agents</div>
                            <ul class="stack" style="gap:6px">{(boot.favours_agents ?? []).map((line: string) => <li class="small">{line}</li>)}</ul>
                        </section>
                    </article>
                )}
            </main>
        </>
    );
}
