import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/Platform', () => ({
    Characteristics: {},
    Services: {},
}));

import OnOff from '../src/mappers/OnOff';
import Light from '../src/mappers/Light';
import { FakePlatform, FakeDevice, FakeCharacteristic } from './helpers';

function make(Mapper: any, deviceOpts = {}) {
    const platform = new FakePlatform();
    const device = new FakeDevice(deviceOpts);
    const mapper = new Mapper(platform as any, {} as any, device as any);
    return { platform, device, mapper };
}

describe('OnOff', () => {
    it('maps on/off to the matching commands', () => {
        const { mapper } = make(OnOff);
        expect(mapper.getOnOffCommands(true).name).toBe('on');
        expect(mapper.getOnOffCommands(false).name).toBe('off');
    });

    it('reflects core:OnOffState onto the On characteristic', () => {
        const { mapper } = make(OnOff);
        mapper.on = new FakeCharacteristic('On', false);
        mapper.onStateChanged('core:OnOffState', 'on');
        expect(mapper.on.value).toBe(true);
        mapper.onStateChanged('core:OnOffState', 'off');
        expect(mapper.on.value).toBe(false);
    });
});

describe('Light', () => {
    it('maps on/off and brightness to commands', () => {
        const { mapper } = make(Light);
        expect(mapper.getOnOffCommands(true).name).toBe('on');
        const b = mapper.getBrightnessCommands(42);
        expect(b.name).toBe('setIntensity');
        expect(b.parameters).toEqual([42]);
    });

    it('builds a setHueAndSaturation command from the current hue and new saturation', () => {
        const { mapper } = make(Light);
        mapper.hue = new FakeCharacteristic('Hue', 120);
        const cmd = mapper.getSaturationCommands(80);
        expect(cmd.name).toBe('setHueAndSaturation');
        expect(cmd.parameters).toEqual([120, 80]);
    });

    it('reflects intensity and color states onto characteristics', () => {
        const { mapper } = make(Light);
        mapper.on = new FakeCharacteristic('On', false);
        mapper.brightness = new FakeCharacteristic('Brightness', 0);
        mapper.hue = new FakeCharacteristic('Hue', 0);
        mapper.saturation = new FakeCharacteristic('Saturation', 0);

        mapper.onStateChanged('core:OnOffState', 'on');
        mapper.onStateChanged('core:LightIntensityState', 55);
        mapper.onStateChanged('core:ColorHueState', 200);
        mapper.onStateChanged('core:ColorSaturationState', 90);

        expect(mapper.on.value).toBe(true);
        expect(mapper.brightness.value).toBe(55);
        expect(mapper.hue.value).toBe(200);
        expect(mapper.saturation.value).toBe(90);
    });
});
