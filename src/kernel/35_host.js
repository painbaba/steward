/*
 * Host integration snapshot.
 *
 * Reads selected fields from the host TSO client's `mainSettings` global so
 * Steward modules can cooperate with host-level user preferences without
 * touching them directly. Defined alongside settings (30) so the rest of the
 * kernel (registry/scheduler/lifecycle) can consult it.
 *
 * The snapshot is read on-demand — `mainSettings` is populated by the host's
 * 0-common.js before any userscript loads, but Steward calls are deferred
 * (boot() fires via setTimeout) so by the time anyone reads from here, the
 * data is fresh.
 *
 * See docs/analysis/HOST_INTEGRATION.md for the full list of fields and why
 * we honour them.
 */

(function (S) {

    function hostMainSettings() {
        try {
            if (typeof mainSettings !== 'undefined' && mainSettings) return mainSettings;
        } catch (e) { /* fall through */ }
        return null;
    }

    function snapshot() {
        var ms = hostMainSettings();
        if (!ms) return {};
        // Copy the fields Steward currently consults. Add to this list when a
        // new field becomes load-bearing somewhere in core/ or modules/.
        var keys = [
            'menuStyle',
            'experimental',
            'explDefTask', 'explDefTaskByType',
            'geoDefTask',  'geoDefTaskByType',
            'specDefTimeType',
            'sortOrder',
            'forcegc',
            'lruCacheSize',
            'highlight'
        ];
        var out = {};
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (typeof ms[k] !== 'undefined') out[k] = ms[k];
        }
        return out;
    }

    function experimental() {
        var ms = hostMainSettings();
        if (!ms) return false;
        return ms.experimental === true;
    }

    function menuStyle() {
        var ms = hostMainSettings();
        if (!ms) return 'grouped';
        return ms.menuStyle || 'grouped';
    }

    // The ByName / Global pair is split deliberately so callers (pickTask /
    // pickDeposits) can apply precedence: per-spec → event-aware → global default.
    // Each function returns null when the host hasn't set a value, so callers
    // can chain falsy checks cleanly.

    function explDefTaskByName(name) {
        var ms = hostMainSettings();
        if (!ms || !name) return null;
        if (ms.explDefTaskByType && typeof ms.explDefTaskByType[name] === 'number') {
            return ms.explDefTaskByType[name];
        }
        return null;
    }

    function explDefTaskGlobal() {
        var ms = hostMainSettings();
        if (!ms) return null;
        return typeof ms.explDefTask === 'number' ? ms.explDefTask : null;
    }

    function geoDefTaskByName(name) {
        var ms = hostMainSettings();
        if (!ms || !name) return null;
        if (ms.geoDefTaskByType && typeof ms.geoDefTaskByType[name] === 'number') {
            return ms.geoDefTaskByType[name];
        }
        return null;
    }

    function geoDefTaskGlobal() {
        var ms = hostMainSettings();
        if (!ms) return null;
        return typeof ms.geoDefTask === 'number' ? ms.geoDefTask : null;
    }

    // Folder the host's own battle-template dialog opens in. Mirrors
    // SaveLoadTemplate.getLastDir + getRealPath (host 0-common.js) for the
    // 'battle' module, without its final documentsDirectory fallback: the
    // caller picks its own default. Returns a path string or null.
    function battleTemplateDir() {
        var lastDir = null;
        try {
            if (typeof settings !== 'undefined' && settings && typeof settings.read === 'function') {
                lastDir = settings.read('battlelastDir');
            }
        } catch (e) {
            S.kernel.warn('host', 'settings.read(battlelastDir) threw: ' + e);
            lastDir = null;
        }
        var ms = hostMainSettings();
        var shortcuts = ms && typeof ms.shortcutsDir === 'string' && ms.shortcutsDir !== ''
            ? ms.shortcutsDir : null;

        // The host treats any stored value other than null as set; its read()
        // already turns missing and empty values into null.
        if (typeof lastDir === 'string' && lastDir !== '') {
            if (ms && ms.shortAsGlobalRelative && shortcuts) return shortcuts + lastDir;
            return lastDir;
        }
        return shortcuts;
    }

    function isAvailable() {
        return hostMainSettings() !== null;
    }

    S.kernel.host = {
        snapshot:           snapshot,
        experimental:       experimental,
        menuStyle:          menuStyle,
        explDefTaskByName:  explDefTaskByName,
        explDefTaskGlobal:  explDefTaskGlobal,
        geoDefTaskByName:   geoDefTaskByName,
        geoDefTaskGlobal:   geoDefTaskGlobal,
        isAvailable:        isAvailable,
        battleTemplateDir:  battleTemplateDir
    };

}(Steward));
