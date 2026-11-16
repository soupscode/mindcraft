// The Messages view: what the relay let through (and what it refused), by conversation.

import type { MessageView } from '../../shared/types';
import { useClient, useJson, useNow } from '../store';
import { bodyLine, clockTime, dayTime, duration } from '../format';
import { Fallback, Monogram, NotConnected } from '../ui';

const STATE_CLASS: Record<string, string> = {
    pending: 'status gold', accepted: 'status on', delivered: 'status', declined: 'status', expired: 'status', rejected: 'status fail',
};
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function merge(stored: MessageView[], live: MessageView[]): MessageView[] {
    const by_key = new Map<string, MessageView>();
    for (const message of stored) by_key.set(`${message.key}@${message.at}`, message);
    for (const message of live) {
        const key = `${message.key}@${message.at}`;
        const known = by_key.get(key);
        if (!known || message.updated_at >= known.updated_at) by_key.set(key, message);
    }
    return [...by_key.values()];
}

interface Thread { conv: string; members: string[]; messages: MessageView[]; last_at: string }

function threads(messages: MessageView[]): Thread[] {
    const by_conv = new Map<string, Thread>();
    for (const message of messages) {
        if (message.state === 'rejected') continue;
        // the relay numbers conversations from 1 again after a restart: the day keeps them apart
        const id = `${message.conv}@${message.at.slice(0, 10)}`;
        const thread = by_conv.get(id) ?? { conv: message.conv, members: [message.from, message.to], messages: [], last_at: message.at };
        thread.messages.push(message);
        if (message.at > thread.last_at) thread.last_at = message.at;
        by_conv.set(id, thread);
    }
    for (const thread of by_conv.values()) {
        // by time; two messages of the same millisecond by their turn number (the end of the msg_id)
        thread.messages.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.msg_id.localeCompare(b.msg_id, undefined, { numeric: true })));
        thread.members = [thread.messages[0].from, thread.messages[0].to];
    }
    return [...by_conv.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
}

function MessageRow({ message, now }: { message: MessageView; now: number }) {
    const left = message.state === 'pending' && message.expires_at ? Date.parse(message.expires_at) - now : null;
    const body = bodyLine(message.body);
    return (
        <li class="msg">
            <span class="mono small muted">{clockTime(message.at)}</span>
            <div class="stack" style="gap:4px">
                <div class="row">
                    <span class="small"><span class="muted">From</span> <b>{message.from}</b> <span class="muted">To</span> <b>{message.to}</b></span>
                    <span class="tag line">{message.type}</span>
                    <span class={STATE_CLASS[message.state] ?? 'status'}>{cap(message.state)}</span>
                    {left !== null && left > 0 && <span class="mono small muted">expires {duration(left)}</span>}
                </div>
                {message.chat_line && <p>{message.chat_line}</p>}
                <div class="row mono small muted">
                    {body && <span>{body}</span>}
                    {message.reason && <span style="color:var(--crimson)">{message.reason}</span>}
                    <span>{message.msg_id}</span>
                </div>
            </div>
        </li>
    );
}

export function Messages() {
    const { live } = useClient();
    const now = useNow(1000);
    const stored = useJson<{ source: string; messages: MessageView[] }>('/api/messages');
    const all = merge(stored.data?.messages ?? [], live.messages);
    const list = threads(all);
    const rejected = all.filter((message) => message.state === 'rejected').sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 30);
    const pending = all.filter((message) => message.state === 'pending').length;
    return (
        <>
            <div class="pills">
                <div class="pill">{list.length} threads</div>
                <div class={pending > 0 ? 'pill gold' : 'pill'}>Pending {pending}</div>
                <div class="pill">Rejected {rejected.length}</div>
            </div>
            <Fallback source={stored.data?.source} />
            {list.length === 0 && <div class="empty">{stored.loading ? 'Loading.' : 'No message in the last 7 days.'}</div>}
            <main class="stack">
                {list.map((thread) => {
                    const last = thread.messages[thread.messages.length - 1];
                    return (
                        <article class="panel stack">
                            <div class="row">
                                <Monogram name={thread.members[0]} small />
                                <Monogram name={thread.members[1]} small />
                                <h2 class="title" style="flex:1">{thread.members[0]} and {thread.members[1]}</h2>
                                <span class="mono small muted">{thread.conv} · {dayTime(thread.last_at)}</span>
                                <span class={STATE_CLASS[last.state] ?? 'status'}>{cap(last.state)}</span>
                            </div>
                            <div class="label">Turns <span class="plain">{thread.messages.length}</span></div>
                            <ol class="rule">{thread.messages.map((message) => <MessageRow message={message} now={now} />)}</ol>
                        </article>
                    );
                })}
            </main>
            {rejected.length > 0 && (
                <section class="panel stack">
                    <h2 class="title">Rejected by the relay</h2>
                    <ol class="rule">{rejected.map((message) => <MessageRow message={message} now={now} />)}</ol>
                </section>
            )}
            <NotConnected what="Limits" missing="Turn, repeat and token budgets live inside the relay; no event carries them." />
        </>
    );
}
