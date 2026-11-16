import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import '@fontsource/cormorant-garamond/latin-500.css';
import '@fontsource/cormorant-garamond/latin-500-italic.css';
import '@fontsource/cormorant-garamond/latin-600.css';
import '@fontsource/cormorant-garamond/latin-700.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './theme.css';
import { connect } from './store';
import { PAGES, Shell } from './ui';
import { Agents } from './views/Agents';
import { Incidents } from './views/Incidents';
import { Messages } from './views/Messages';
import { Trace } from './views/Trace';
import { Controls } from './views/Controls';
import { Digest } from './views/Digest';
import { Routines } from './views/Routines';
import { Memory, Repair, World } from './views/Pending';

function currentPath(): { path: string; arg: string | null } {
    const hash = location.hash.replace(/^#/, '') || '/';
    const [, first = '', arg = null] = hash.split('/');
    const path = `/${first}`;
    return { path: PAGES.some((page) => page.path === path) ? path : '/', arg: arg ? decodeURIComponent(arg) : null };
}

function App() {
    const [route, setRoute] = useState(currentPath());
    useEffect(() => {
        const onHash = () => { setRoute(currentPath()); window.scrollTo(0, 0); };
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);
    const { path, arg } = route;
    return (
        <Shell path={path}>
            {path === '/' && <Agents />}
            {path === '/incidents' && <Incidents />}
            {path === '/messages' && <Messages />}
            {path === '/trace' && <Trace selected={arg} />}
            {path === '/controls' && <Controls />}
            {path === '/digest' && <Digest />}
            {path === '/routines' && <Routines />}
            {path === '/memory' && <Memory />}
            {path === '/world' && <World />}
            {path === '/repair' && <Repair />}
        </Shell>
    );
}

connect();
render(<App />, document.getElementById('app')!);
