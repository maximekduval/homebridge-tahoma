import { describe, it, expect, beforeAll } from 'vitest';
import * as ClientModule from 'overkiz-client/dist/Client';
import ApiClient from 'overkiz-client/dist/ApiClient';
import { FakeLogger } from './helpers';

// These tests run against the installed overkiz-client, so they also check that
// patches/overkiz-client+*.patch was applied by `npm install` (postinstall).

type FakeResponse = { status: number; data: unknown };

class CountingApiClient extends ApiClient {
    logins = 0;
    constructor(responses: FakeResponse[]) {
        super();
        this.setCredentials('user', 'password');
        this.client.defaults.adapter = async (config: any) => {
            const next = responses.shift();
            if (!next) {
                throw new Error('No more fake responses');
            }
            const response: any = { ...next, statusText: '', headers: {}, config, request: {} };
            if (next.status >= 400) {
                const error: any = new Error('Request failed with status code ' + next.status);
                error.isAxiosError = true;
                error.response = response;
                error.config = config;
                throw error;
            }
            return response;
        };
    }

    protected async authenticate() {
        this.logins++;
    }
}

beforeAll(() => {
    // The request interceptor logs through the module-level logger, which the
    // real Client sets in its constructor.
    (ClientModule as any).logger = new FakeLogger();
});

describe('overkiz-client ApiClient', () => {
    it('logs in again and retries once on 429 QUOTA_EXCEEDED', async () => {
        const api = new CountingApiClient([
            { status: 429, data: { errorCode: 'QUOTA_EXCEEDED', error: 'Quota exceeded' } },
            { status: 200, data: { ok: true } },
        ]);
        await expect(api.get('/setup')).resolves.toEqual({ ok: true });
        expect(api.logins).toBe(2);
    });

    it('does not retry a second 429 QUOTA_EXCEEDED in a row', async () => {
        const api = new CountingApiClient([
            { status: 429, data: { errorCode: 'QUOTA_EXCEEDED' } },
            { status: 429, data: { errorCode: 'QUOTA_EXCEEDED' } },
            { status: 200, data: { ok: true } },
        ]);
        await expect(api.get('/setup')).rejects.toBe('Error 429 (QUOTA_EXCEEDED)');
        expect(api.logins).toBe(2);
    });

    it('does not log in again on another 429', async () => {
        const api = new CountingApiClient([
            { status: 429, data: { errorCode: 'TOO_MANY_REQUESTS' } },
        ]);
        await expect(api.get('/setup')).rejects.toBe('Error 429 (TOO_MANY_REQUESTS)');
        expect(api.logins).toBe(1);
    });

    it('still logs in again and retries once on 401 after a session expiry', async () => {
        const api = new CountingApiClient([
            { status: 200, data: { ok: true } },
            { status: 401, data: { errorCode: 'RESOURCE_ACCESS_DENIED' } },
            { status: 200, data: { ok: 'again' } },
        ]);
        await api.get('/setup');
        await expect(api.get('/setup')).resolves.toEqual({ ok: 'again' });
        expect(api.logins).toBe(2);
    });
});
