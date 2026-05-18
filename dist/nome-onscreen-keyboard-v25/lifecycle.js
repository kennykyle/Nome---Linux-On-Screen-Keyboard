/* Nome - Onscreen Keyboard lifecycle helpers. */

import GLib from 'gi://GLib';

export function _removeSource(id) {
    if (!id) return;
    try { GLib.source_remove(id); }
    catch (_e) {}
}

export function _clearSource(owner, prop) {
    if (!owner || !owner[prop]) return;
    _removeSource(owner[prop]);
    owner[prop] = 0;
}

export class OskLifecycleTracker {
    constructor(owner = null) {
        this._owner = owner;
        this._sources = new Set();
        this._signals = [];
    }

    connect(obj, signal, callback) {
        if (!obj || typeof obj.connect !== 'function') return 0;
        const id = obj.connect(signal, callback);
        if (id) this._signals.push([obj, id]);
        return id || 0;
    }

    timeoutAdd(prop, priority, intervalMs, callback) {
        const owner = this._owner;
        let id = 0;
        id = GLib.timeout_add(priority, intervalMs, () => {
            const result = callback();
            if (result === GLib.SOURCE_REMOVE || result === false) {
                this._sources.delete(id);
                if (owner && prop && owner[prop] === id)
                    owner[prop] = 0;
            }
            return result;
        });
        if (id) {
            this._sources.add(id);
            if (owner && prop) owner[prop] = id;
        }
        return id || 0;
    }

    clearSource(prop) {
        if (!this._owner || !prop) return;
        const id = this._owner[prop];
        this._owner[prop] = 0;
        if (!id) return;
        this._sources.delete(id);
        _removeSource(id);
    }

    clear() {
        for (const id of this._sources)
            _removeSource(id);
        this._sources.clear();

        for (let i = this._signals.length - 1; i >= 0; i--) {
            const [obj, id] = this._signals[i];
            try { obj.disconnect(id); } catch (_e) {}
        }
        this._signals = [];
    }
}
