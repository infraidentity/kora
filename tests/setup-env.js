// Tests run against an in-memory database and a fake INFRA (tests/fake-infra.js).
process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.CLIENT_ID = 'kora-main';
process.env.CLIENT_SECRET = 'main-secret';
process.env.PAYV_CLIENT_ID = 'kora-merchant';
process.env.PAYV_CLIENT_SECRET = 'payv-secret';
process.env.WEBHOOK_SECRET = 'whsec_test_0123456789abcdef';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.INFRA_API_BASE_URL = 'https://api.infra.test';
process.env.DEV_PANEL_KEY = '';
