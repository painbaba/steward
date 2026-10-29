/*
 * Test harness.
 *
 * boot(opts) returns a fresh Steward instance with stubbed host globals.
 * Source files load via vm.runInContext in build order from tests/load-order.js,
 * so the bundled AIR runtime and the Node test environment see the same code
 * with the same load sequence.
 *
 * Per-test isolation: each boot() call creates a brand-new vm context. State
 * does not leak between tests (no shared Steward, no shared host globals).
 * Source is version-substituted the same way as the build (scripts/version.js).
 * reload(H) is the one deliberate exception: it re-runs the same files into
 * H.ctx, which simulates the host's reloadScripts injecting a second bundle
 * into the same page and global.
 *
 * Usage:
 *   var H = harness.boot();                 // kernel + core + modules
 *   var H = harness.boot({ sections: ['kernel'] });   // partial
 *   H.settings.write('mining', { enabled: true });
 *   H.module('mining').plan({ zone: { isHome: true } });
 *   assert(H.queued().length === 1);
 *   var H2 = harness.reload(H);             // second injection, same context
 *
 * opts.timers may override setTimeout / clearTimeout / setInterval /
 * clearInterval in the context (default: inert stubs).
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var vm   = require('vm');

var hostStubs   = require('./stubs/host');
var zoneStubs   = require('./stubs/zone');
var specStubs   = require('./stubs/specialists');
var kernelStubs = require('./stubs/kernel');
var loadOrder   = require('./load-order');
var version     = require('../scripts/version');

var REPO_ROOT = path.resolve(__dirname, '..');

function readSource(rel) {
    return version.inject(
        fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'),
        version.read(REPO_ROOT)
    );
}

function boot(opts) {
    opts = opts || {};
    var sections = opts.sections || ['kernel', 'core', 'modules'];

    var host = hostStubs.make(opts.host || {});

    var timers = opts.timers || {};

    var ctx = {
        // Node stdlib that source files might touch (defensive).
        setTimeout:   timers.setTimeout   || function () { return 0; },
        clearTimeout: timers.clearTimeout || function () {},
        setInterval:  timers.setInterval  || function () { return 0; },
        clearInterval: timers.clearInterval || function () {},
        Date:    Date,
        Math:    Math,
        JSON:    JSON,
        Object:  Object,
        Array:   Array,
        String:  String,
        Number:  Number,
        Boolean: Boolean,
        Error:   Error,
        RegExp:  RegExp,
        console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },

        // Steward-namespace placeholder. kernel/00_namespace.js seeds it; its
        // `var Steward = (typeof Steward !== 'undefined' && Steward) || {};`
        // means a pre-set value would be reused, so we leave it undefined.
        Steward: undefined,

        // Host globals.
        loca:           host.loca,
        air:            host.air,
        settings:       host.settings,
        mainSettings:   host.mainSettings,
        $:              host.$,
        globalFlash:    host.globalFlash,
        getImageTag:    host.getImageTag,
        showGameAlert:  host.showGameAlert,
        debug:          host.debug,
        game:           host.game,
        swmmo:          host.swmmo
    };
    vm.createContext(ctx);

    return load(ctx, host, sections);
}

// Runs the section files into ctx and wraps the resulting Steward.
function load(ctx, host, sections) {
    var files = loadOrder.collect(sections, REPO_ROOT);
    for (var i = 0; i < files.length; i++) {
        var rel = files[i];
        var body = readSource(rel);
        try {
            vm.runInContext(body, ctx, { filename: rel });
        } catch (e) {
            throw new Error('Failed loading ' + rel + ': ' + (e.stack || e.message));
        }
    }

    var Steward = ctx.Steward;
    if (!Steward) {
        throw new Error('Bootstrap failed — Steward global not set after loading ' + files.length + ' files');
    }

    var caps = kernelStubs.attachCaptures(Steward);

    return {
        Steward:    Steward,
        ctx:        ctx,
        host:       host,
        sections:   sections,
        zone:       zoneStubs,
        specs:      specStubs,
        logs:       caps.logs,
        queued:     caps.queued,
        clearLogs:  caps.clearLogs,
        clearQueued: caps.clearQueued,
        settings:   {
            read:  function (id)      { return Steward.kernel.settings.read(id); },
            write: function (id, val) { return Steward.kernel.settings.write(id, val); },
            store: caps.settingsStore
        },
        installZone: function (zoneFluent) {
            host.game.gi.mCurrentPlayer = host.game.gi.mCurrentPlayer || {};
            host.game.gi.mCurrentPlayerZone = zoneFluent.zone;
            zoneFluent.mountOnPlayer(host.game.gi.mCurrentPlayer);
            return zoneFluent;
        },
        module: function (id) {
            if (!Steward.kernel.registry || typeof Steward.kernel.registry.get !== 'function') {
                return null;
            }
            return Steward.kernel.registry.get(id);
        }
    };
}

// Simulates the host's reloadScripts: re-runs the same files (or
// opts.sections) into the existing context and returns a new harness object.
function reload(H, opts) {
    opts = opts || {};
    return load(H.ctx, H.host, opts.sections || H.sections);
}

function noop() {}

module.exports = { boot: boot, reload: reload };
