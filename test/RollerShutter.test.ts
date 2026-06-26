import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/Platform', () => ({
    Characteristics: {
        PositionState: { DECREASING: 0, INCREASING: 1, STOPPED: 2 },
    },
    Services: {},
}));

import RollerShutter from '../src/mappers/RollerShutter';
import { FakePlatform, FakeDevice, FakeCharacteristic } from './helpers';

function makeRoller(deviceOpts = {}, fields: Record<string, unknown> = {}) {
    const platform = new FakePlatform();
    const device = new FakeDevice({ uiClass: 'RollerShutter', widgetName: 'RollerShutter', ...deviceOpts });
    const roller = new RollerShutter(platform as any, {} as any, device as any) as any;
    roller.currentPosition = new FakeCharacteristic('CurrentPosition', 0);
    roller.targetPosition = new FakeCharacteristic('TargetPosition', 0);
    Object.assign(roller, fields);
    return { platform, device, roller };
}

describe('RollerShutter.reversedValue', () => {
    it('inverts the value by default (HomeKit open=100 maps to 0% closure)', () => {
        const { roller } = makeRoller({}, { reverse: false });
        expect(roller.reversedValue(30)).toBe(70);
        expect(roller.reversedValue(100)).toBe(0);
    });

    it('keeps the value when reverse is enabled', () => {
        const { roller } = makeRoller({}, { reverse: true });
        expect(roller.reversedValue(30)).toBe(30);
    });
});

describe('RollerShutter.getTargetCommands (stateless)', () => {
    it('maps fully open / closed to open / close commands', () => {
        const { roller } = makeRoller({}, { stateless: true, reverse: false, movementDuration: 0 });
        expect((roller.getTargetCommands(100) as any).name).toBe('open');
        expect((roller.getTargetCommands(0) as any).name).toBe('close');
    });

    it('uses the "my" command for an intermediate position without movementDuration', () => {
        const { roller } = makeRoller({}, { stateless: true, reverse: false, movementDuration: 0 });
        expect((roller.getTargetCommands(50) as any).name).toBe('my');
    });

    it('chooses open/close by delta when movementDuration is set', () => {
        const { roller } = makeRoller({}, { stateless: true, reverse: false, movementDuration: 10 });
        roller.currentPosition.value = 20;
        expect((roller.getTargetCommands(60) as any).name).toBe('open'); // delta > 0
        expect((roller.getTargetCommands(10) as any).name).toBe('close'); // delta < 0
    });
});

describe('RollerShutter.getTargetCommands (positionable)', () => {
    it('sends setClosure with the reversed value', () => {
        const { roller } = makeRoller({}, { stateless: false, reverse: false });
        const cmd = roller.getTargetCommands(30) as any;
        expect(cmd.name).toBe('setClosure');
        expect(cmd.parameters).toEqual([70]);
    });
});

describe('RollerShutter.onStateChanged', () => {
    it('maps core:ClosureState to the reversed current position', () => {
        const { roller } = makeRoller(); // no TargetClosureState state present
        roller.onStateChanged('core:ClosureState', 30);
        expect(roller.currentPosition.value).toBe(70);
        // No TargetClosureState reported and idle -> target tracks current.
        expect(roller.targetPosition.value).toBe(70);
    });

    it('does not move the target to match current while a command is in flight', () => {
        const { roller, platform } = makeRoller();
        roller.targetPosition.value = 40;
        platform.client.hasExecution.mockReturnValue(true); // not idle
        roller.onStateChanged('core:ClosureState', 30);
        expect(roller.currentPosition.value).toBe(70); // current always reflects device
        expect(roller.targetPosition.value).toBe(40); // target preserved
    });

    it('maps core:TargetClosureState to the reversed target position', () => {
        const { roller } = makeRoller();
        roller.onStateChanged('core:TargetClosureState', 25);
        expect(roller.targetPosition.value).toBe(75);
    });
});
