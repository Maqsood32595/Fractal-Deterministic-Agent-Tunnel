module.exports = function (getApiKeys) {
    return function authenticate(req, res, next) {
        const apiKey = req.headers['x-api-key'];
        if (!apiKey) {
            return res.status(401).json({ error: 'API key required. Header: x-api-key' });
        }

        const keys = getApiKeys();
        const client = keys[apiKey];

        if (!client) {
            return res.status(403).json({ error: 'Invalid API key' });
        }

        req.client = client;
        next();
    };
};
