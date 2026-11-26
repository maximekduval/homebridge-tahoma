import { describe, it, expect, vi } from 'vitest';

// NB: no vi.mock('../src/Platform') here — unlike the mapper tests, we exercise
// the real module to test its refreshPeriod translation.
import { Platform, resolveRefreshPeriod, shouldRefreshOnStartup } from '../src/Platform';

// Mirror of how overkiz-client turns the resolved refreshPeriod into a timer:
//   Client:               refreshPeriod = (config.refreshPeriod || 30) * 60   // seconds
//   setRefreshTaskPeriod: if (period > 0) setInterval(fn, period * 1000)      // ms
// Returns the setInterval delay in ms (or null when no interval is armed).
function scheduledIntervalMs(resolved: unknown): number | null {
    const periodSeconds = ((resolved as number) || 30) * 60;
    return periodSeconds > 0 ? periodSeconds * 1000 : null;
}

// Node stores a timer delay as a signed 32-bit int; anything above this is
// clamped to 1 ms (the bug that made refreshPeriod: 0 fire the refresh ~1000x/s).
const NODE_MAX_TIMER_MS = 2_147_483_647;

describe('resolveRefreshPeriod', () => {
    it('passes through a normal positive period unchanged', () => {
        expect(resolveRefreshPeriod(30)).toBe(30);
        expect(resolveRefreshPeriod(120)).toBe(120);
    });

    it('leaves an unset period untouched (overkiz applies its own default)', () => {
        expect(resolveRefreshPeriod(undefined)).toBe(undefined);
    });

    it('translates 0 into a non-positive sentinel so overkiz never arms the timer', () => {
        const resolved = resolveRefreshPeriod(0);
        expect(resolved as number).toBeLessThanOrEqual(0);
        // overkiz's `period > 0` guard must skip scheduling entirely.
        expect(scheduledIntervalMs(resolved)).toBeNull();
    });

    it('never produces a setInterval delay that overflows Node\'s 32-bit timer', () => {
        for (const input of [0, 30, 120, undefined]) {
            const delay = scheduledIntervalMs(resolveRefreshPeriod(input));
            if (delay !== null) {
                expect(delay).toBeGreaterThan(0);
                expect(delay).toBeLessThanOrEqual(NODE_MAX_TIMER_MS);
            }
        }
    });
});

describe('shouldRefreshOnStartup', () => {
    it('forces a startup refresh when the periodic refresh is enabled', () => {
        // Values as they reach the platform after resolveRefreshPeriod.
        expect(shouldRefreshOnStartup(resolveRefreshPeriod(30))).toBe(true);
        expect(shouldRefreshOnStartup(resolveRefreshPeriod(120))).toBe(true);
        // Unset → overkiz default applies, refresh still wanted at startup.
        expect(shouldRefreshOnStartup(resolveRefreshPeriod(undefined))).toBe(true);
    });

    it('skips the startup refresh when the user disabled the periodic refresh (0 → sentinel)', () => {
        expect(shouldRefreshOnStartup(resolveRefreshPeriod(0))).toBe(false);
    });
});

describe('Platform.resyncDeviceStates', () => {
    // Called on the prototype with a stand-in: building a whole Platform needs homebridge.
    function resync(self: { client: { refreshDevices: () => Promise<void> }; resyncPromise: Promise<void> | null }) {
        return (Platform.prototype as any).resyncDeviceStates.call(self) as Promise<void>;
    }

    it('shares one read between calls made while it runs', async () => {
        let finish!: () => void;
        const refreshDevices = vi.fn(() => new Promise<void>((resolve) => {
            finish = resolve;
        }));
        const self = { client: { refreshDevices }, resyncPromise: null };

        const first = resync(self);
        const second = resync(self);
        expect(second).toBe(first);
        expect(refreshDevices).toHaveBeenCalledTimes(1);

        finish();
        await first;
    });

    it('reads again once the previous read is done, also after a failure', async () => {
        const refreshDevices = vi.fn()
            .mockRejectedValueOnce(new Error('Error 504'))
            .mockResolvedValueOnce(undefined);
        const self = { client: { refreshDevices }, resyncPromise: null };

        await expect(resync(self)).rejects.toThrow('Error 504');
        await resync(self);

        expect(refreshDevices).toHaveBeenCalledTimes(2);
    });
});
