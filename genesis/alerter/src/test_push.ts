// genesis/up.sh --test-alert: one harmless push through the alerter's own notifier.
// The test push: says plainly that nothing is wrong, never repeats, and leaves ONE closed alert row of
// kind "test" whose push_state says how it went ("sent": ntfy took it; that is not yet the phone ringing).
export async function sendTestPush({ notifier, store, ids, clock = { now: Date.now } }: {
    notifier: { enabled(): boolean; send(push: any): Promise<string> }; store: { saveAlert(alert: any): Promise<void> }; ids: () => string; clock?: { now(): number };
}): Promise<{ ok: boolean; line: string }> {
    const at = new Date(clock.now()).toISOString();
    if (!notifier.enabled()) return { ok: false, line: 'Test push NOT sent: no ntfy topic is set (GENESIS_NTFY_TOPIC).' };
    const result = await notifier.send({ title: 'Genesis · test alert', body: 'This is a test. Nothing is wrong. Critical alerts arrive like this one, once.', priority: 'default', tags: ['white_check_mark'] });
    try {
        await store.saveAlert({
            id: ids(), problem_key: `test:${at}`, severity: 'warning', title: 'Test push', subject: 'operator', kind: 'test',
            opened_at: at, updated_at: at, closed_at: at, occurrences: 1, push_state: result === 'delivered' ? 'sent' : result === 'unknown' ? 'unconfirmed' : 'failed', pushed_at: result === 'refused' ? null : at,
        });
    } catch { /* Postgres is down: the push itself still went */ }
    return result === 'delivered' ? { ok: true, line: 'Test push accepted by ntfy. If the phone stays silent, it is not subscribed to the topic.' }
        : { ok: false, line: result === 'unknown' ? 'Test push: ntfy did not answer; it may or may not have gone out.' : 'Test push REFUSED by ntfy: check the server address, the topic and the token.' };
}
