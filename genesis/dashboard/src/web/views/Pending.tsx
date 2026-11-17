// Views whose data no event carries today. Each says what is missing; none shows made-up data.
// (The World view has its events now: views/World.tsx.)

import { NotConnected } from '../ui';

export function Memory() {
    return <NotConnected what="Memory" missing="No event carries an agent's identity, places, commitments or journal, and nothing reports what went into a prompt. Needs a memory snapshot event (or an endpoint on the MindServer)." />;
}


export function Repair() {
    return <NotConnected what="Repair" missing="Repair sessions are not built yet: no event reports a session, its bundle, its patch or its verdict." />;
}
