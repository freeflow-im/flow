import { afterEach, describe, expect, it, vi } from 'vitest';
import { canPickSpeaker, groupDevices, pickDevice, rememberDevice, rememberedDevices, routeToSpeaker } from './devices';

const dev = (kind: MediaDeviceKind, deviceId: string, label = '') => ({ kind, deviceId, label });

describe('device choice', () => {
  afterEach(() => localStorage.clear());

  it('groups devices by kind, names unnamed ones and drops blank ids and repeats', () => {
    const lists = groupDevices([
      dev('videoinput', 'cam1', 'FaceTime HD Camera'),
      dev('audioinput', 'default', 'Default - MacBook Pro Microphone'),
      dev('audioinput', 'mic2'),
      dev('audioinput', 'mic2'),
      dev('audiooutput', ''),
    ]);
    expect(lists.videoinput).toEqual([{ id: 'cam1', label: 'FaceTime HD Camera' }]);
    expect(lists.audioinput).toEqual([
      { id: 'default', label: 'Default - MacBook Pro Microphone' },
      { id: 'mic2', label: 'Microphone 2' },
    ]);
    expect(lists.audiooutput).toEqual([]);
  });

  it('uses the chosen device while it is plugged in, else the default, else the first', () => {
    const list = [
      { id: 'a', label: 'A' },
      { id: 'default', label: 'Default' },
    ];
    expect(pickDevice(list, 'a')).toBe('a');
    expect(pickDevice(list, 'unplugged')).toBe('default');
    expect(pickDevice([{ id: 'a', label: 'A' }], 'unplugged')).toBe('a');
    expect(pickDevice([], 'a')).toBeUndefined();
  });

  it('remembers each kind separately', () => {
    expect(rememberedDevices()).toEqual({});
    rememberDevice('audioinput', 'mic2');
    rememberDevice('audiooutput', 'airpods');
    expect(rememberedDevices()).toEqual({ audioinput: 'mic2', audiooutput: 'airpods' });
    localStorage.setItem('flow.meet.devices', 'not json');
    expect(rememberedDevices()).toEqual({});
  });

  it('only routes sound where the browser can choose a speaker', async () => {
    const plain = document.createElement('audio');
    expect(() => routeToSpeaker(plain, 'airpods')).not.toThrow();
    const setSinkId = vi.fn(() => Promise.resolve());
    const able = Object.assign(document.createElement('audio'), { setSinkId, sinkId: '' });
    routeToSpeaker(able, 'airpods');
    expect(setSinkId).toHaveBeenCalledWith('airpods');
    expect(canPickSpeaker()).toBe('setSinkId' in HTMLMediaElement.prototype);
  });
});
