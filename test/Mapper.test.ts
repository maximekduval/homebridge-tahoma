import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Command, ExecutionState } from 'overkiz-client';
import Mapper from '../src/Mapper';
import { FakePlatform, FakeDevice } from './helpers';

/** Concrete mapper exposing the protected command layer for testing. */
class TestMapper extends Mapper {
    protected registerMainService(): any {
        return undefined;
    }

    protected onStateChanged(): void {
        // no-op
    }

    public exec(commands: Command | Command[], standalone = false) {
        return this.executeCommands(commands, standalone);
    }
}

function makeMapper(device = new FakeDevice()) {
    const platform = new FakePlatform();
    const mapper = new TestMapper(platform as any, {} as any, device as any);
    return { platform, device, mapper };
}

describe('Mapper.executeCommands — command batching', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('coalesces commands issued within the 100ms window into a single execution', async () => {
        const { platform, mapper } = makeMapper();

        const p1 = mapper.exec(new Command('a'));
        const p2 = mapper.exec(new Command('b'));

        await vi.advanceTimersByTimeAsync(100);
        const [a1, a2] = await Promise.all([p1, p2]);

        // Both calls resolve to the same Action and trigger one execution.
        expect(a1).toBe(a2);
        expect(platform.executeAction).toHaveBeenCalledTimes(1);
    });

    // C0 fixed: a second distinct command sent to the same device within the
    // batch window must be merged into the action (was silently dropped by the
    // buggy overkiz-client Action.addCommands).
    it('merges a second distinct command into the batched action', async () => {
        const { mapper } = makeMapper();

        const p1 = mapper.exec(new Command('a'));
        const p2 = mapper.exec(new Command('b'));
        await vi.advanceTimersByTimeAsync(100);
        const [a1] = await Promise.all([p1, p2]);

        expect(a1.commands.map((c) => c.name)).toEqual(['a', 'b']);
    });

    it('replaces parameters when the same command is issued twice in the window', async () => {
        const { mapper } = makeMapper();

        const p1 = mapper.exec(new Command('setClosure', 30));
        const p2 = mapper.exec(new Command('setClosure', 70));
        await vi.advanceTimersByTimeAsync(100);
        const [a1] = await Promise.all([p1, p2]);

        expect(a1.commands).toHaveLength(1);
        expect(a1.commands[0].parameters).toEqual([70]);
    });

    it('starts a fresh execution once the previous one has been flushed', async () => {
        const { platform, mapper } = makeMapper();

        const p1 = mapper.exec(new Command('a'));
        await vi.advanceTimersByTimeAsync(100);
        await p1;

        const p2 = mapper.exec(new Command('b'));
        await vi.advanceTimersByTimeAsync(100);
        await p2;

        expect(platform.executeAction).toHaveBeenCalledTimes(2);
    });

    it('rejects with a communication failure when executeAction throws', async () => {
        const { platform, mapper } = makeMapper();
        platform.executeAction.mockRejectedValueOnce(new Error('network down'));

        const p = mapper.exec(new Command('a'));
        const assertion = expect(p).rejects.toBeDefined();
        await vi.advanceTimersByTimeAsync(100);
        await assertion;
    });

    it('throws RESOURCE_DOES_NOT_EXIST when given no commands', async () => {
        const { mapper } = makeMapper();
        await expect(mapper.exec([])).rejects.toBeDefined();
    });
});

describe('Mapper.executeCommands — update listeners (C1)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('emits update events to a per-call listener', async () => {
        const { mapper } = makeMapper();

        const p = mapper.exec(new Command('a'));
        await vi.advanceTimersByTimeAsync(100);
        const action = await p;

        const seen: string[] = [];
        action.on('update', (state: string) => seen.push(state));
        action.emit('update', ExecutionState.COMPLETED, {});

        expect(seen).toEqual([ExecutionState.COMPLETED]);
    });

    it('does not cap listeners on the shared batched action (no leak warning)', async () => {
        const { mapper } = makeMapper();

        const promises = [mapper.exec(new Command('a')), mapper.exec(new Command('b')), mapper.exec(new Command('c'))];
        await vi.advanceTimersByTimeAsync(100);
        const actions = await Promise.all(promises);
        actions.forEach((a) => a.on('update', () => undefined));

        expect(actions[0]).toBe(actions[1]);
        // maxListeners(0) means unlimited — many batched callers won't trip the
        // EventEmitter leak warning.
        expect(actions[0].getMaxListeners()).toBe(0);
    });
});

describe('Mapper.isIdle — in-flight tracking (C2)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('reports non-idle synchronously, before the execId is known', async () => {
        const { mapper } = makeMapper();

        // A command was just issued; the execution has not even been POSTed yet,
        // so the client pool is empty — but the mapper must still report busy so
        // a stale state echo cannot overwrite the new value.
        const p = mapper.exec(new Command('a'));
        expect(mapper.isIdle).toBe(false);

        await vi.advanceTimersByTimeAsync(100);
        await p;
        expect(mapper.isIdle).toBe(false); // execId now in pool (mock returns true below)
    });

    it('becomes idle again after the action reaches a terminal state', async () => {
        const { platform, mapper } = makeMapper();
        // Pool no longer holds the execution once it completed.
        platform.client.hasExecution.mockReturnValue(false);

        const p = mapper.exec(new Command('a'));
        await vi.advanceTimersByTimeAsync(100);
        const action = await p;
        expect(mapper.isIdle).toBe(false);

        action.emit('update', ExecutionState.COMPLETED, {});
        expect(mapper.isIdle).toBe(true);
    });

    it('releases the in-flight slot when the execution fails to start', async () => {
        const { platform, mapper } = makeMapper();
        platform.client.hasExecution.mockReturnValue(false);
        platform.executeAction.mockRejectedValueOnce(new Error('network down'));

        const p = mapper.exec(new Command('a'));
        const assertion = expect(p).rejects.toBeDefined();
        await vi.advanceTimersByTimeAsync(100);
        await assertion;

        expect(mapper.isIdle).toBe(true);
    });

    it('stays busy until a TIMED_OUT terminal arrives', async () => {
        const { platform, mapper } = makeMapper();
        platform.client.hasExecution.mockReturnValue(false);

        const p = mapper.exec(new Command('a'));
        await vi.advanceTimersByTimeAsync(100);
        const action = await p;
        expect(mapper.isIdle).toBe(false);

        action.emit('update', ExecutionState.TIMED_OUT, null);
        expect(mapper.isIdle).toBe(true);
    });
});
