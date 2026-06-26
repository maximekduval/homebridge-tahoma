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

    // KNOWN BUG (C0): overkiz-client Action.addCommands iterates `this.commands`
    // instead of the incoming `commands`, so a second distinct command sent to the
    // same device within the batch window is silently dropped. This is a direct
    // cause of "temperature sent but not applied". Phase 1 must work around it;
    // when fixed, remove `.fails` and the test should pass.
    it.fails('merges a second distinct command into the batched action', async () => {
        const { mapper } = makeMapper();

        const p1 = mapper.exec(new Command('a'));
        const p2 = mapper.exec(new Command('b'));
        await vi.advanceTimersByTimeAsync(100);
        const [a1] = await Promise.all([p1, p2]);

        expect(a1.commands.map((c) => c.name)).toEqual(['a', 'b']);
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

describe('Mapper.executeCommands — update listeners (characterizes C1)', () => {
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

    it('CHARACTERIZATION: batched callers share one Action, so listeners accumulate on it', async () => {
        const { mapper } = makeMapper();

        // Simulate several rapid HomeKit writes that each attach their own listener.
        const promises = [mapper.exec(new Command('a')), mapper.exec(new Command('b')), mapper.exec(new Command('c'))];
        await vi.advanceTimersByTimeAsync(100);
        const actions = await Promise.all(promises);
        actions.forEach((a) => a.on('update', () => undefined));

        // All three resolved to the same Action — today every caller piles a
        // listener onto this shared emitter (the C1 leak). This documents current
        // behaviour; Phase 1 should make per-call listeners independent.
        expect(actions[0]).toBe(actions[1]);
        expect(actions[0]).toBe(actions[2]);
        // base listener (from executeCommands) + 3 from callers above.
        expect(actions[0].listenerCount('update')).toBeGreaterThanOrEqual(4);
    });
});
