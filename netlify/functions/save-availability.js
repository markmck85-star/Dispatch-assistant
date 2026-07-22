const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event) => {
  connectLambda(event);
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    try {
        const { manualUnavailable, date } = JSON.parse(event.body);
        const store = getStore('dispatch');
        await store.setJSON('availability', { manualUnavailable, date });
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
