const fs = require('fs');
const path = require('path');
const express = require('express');

class Kernel {
    constructor() {
        this.features = new Map();
        this.app = null;
    }

    boot(app, tunnelsRef, apiKeysRef, rootDir = './features') {
        console.log('🚀 [Kernel] Booting Fractal Architecture...');
        this.app = app;
        this.tunnelsRef = tunnelsRef;
        this.apiKeysRef = apiKeysRef;
        const rootPath = path.resolve(rootDir);

        if (!fs.existsSync(rootPath)) {
            fs.mkdirSync(rootPath, { recursive: true });
        }

        this._scan(rootPath);
        this._mount();

        console.log(`✅ [Kernel] System Online. ${this.features.size} isolated features loaded.`);
    }

    _scan(dir) {
        if (!fs.existsSync(dir)) return;

        const manifestPath = path.join(dir, 'feature.manifest.json');
        if (fs.existsSync(manifestPath)) {
            this._register(dir, manifestPath);
            return;
        }

        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
            if (item.isDirectory() && !this._isIgnored(item.name)) {
                this._scan(path.join(dir, item.name));
            }
        }
    }

    _register(dir, manifestPath) {
        try {
            const manifest = require(manifestPath);
            if (!manifest.id) throw new Error('Manifest missing ID');

            this.features.set(manifest.id, {
                ...manifest,
                _path: dir
            });

            // Fractal Injection: Tunnels
            if (manifest.tunnels && this.tunnelsRef) {
                Object.assign(this.tunnelsRef, manifest.tunnels);
                console.log(`   🔒 Injected ${Object.keys(manifest.tunnels).length} Tunnels`);
            }

            // Fractal Injection: Agents
            if (manifest.agents && this.apiKeysRef) {
                Object.assign(this.apiKeysRef, manifest.agents);
                console.log(`   🤖 Injected ${Object.keys(manifest.agents).length} Agents`);
            }

            console.log(`📦 [Discovered] ${manifest.id}`);
        } catch (e) {
            console.error(`❌ [Error] Invalid Manifest at ${dir}:`, e.message);
        }
    }

    _mount() {
        for (const [id, feature] of this.features) {
            if (feature.routes) {
                const routePath = path.join(feature._path, feature.routes);
                if (fs.existsSync(routePath)) {
                    this.app.use(feature.basePath || `/api/${id}`, require(routePath));
                }
            }
            const uiPath = path.join(feature._path, 'ui');
            if (fs.existsSync(uiPath)) {
                this.app.use(`/features/${id}`, express.static(uiPath));
            }
        }
    }

    _isIgnored(name) {
        return ['node_modules', '.git', 'dist'].includes(name);
    }
}

module.exports = new Kernel();
