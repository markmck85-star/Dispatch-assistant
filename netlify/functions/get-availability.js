const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event) => {
    connectLambda(event);
    try {
        const store = getStore('dispatch');
        const data = await store.get('availability', { type: 'json' });
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data || { manualUnavailable: {}, date: null })
        };
    } catch {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ manualUnavailable: {}, date: null })
        };
    }
};
