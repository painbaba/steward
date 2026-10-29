/*
 * Script reload teardown.
 *
 * When the host reloads userscripts it injects this bundle again into the same
 * page and the same global, so the instance a previous injection left running
 * keeps its scheduler timer and status interval alive. This file tears that
 * instance down before the new one takes over.
 *
 * Bundle place: 05_, right after 00_namespace.js and before every file that
 * replaces a Steward.kernel slot. The previous instance's handles are only
 * reachable through those slots until the later kernel files overwrite them.
 * Kept before 10_ so the rule is simply "first after the namespace".
 *
 * It must never throw (a throw at bundle top would abort the whole new bundle)
 * and never write settings: the persisted pause is read by the new boot.
 */

(function (S) {

    // Calls obj[name]() of the previous instance. True only when the method
    // existed and returned without throwing, so callers can pick a fallback.
    function callOld(obj, name) {
        if (!obj || typeof obj[name] !== 'function') return false;
        try {
            obj[name]();
            return true;
        } catch (e) {
            return false;
        }
    }

    var k = S.kernel;

    // First load: no previous instance, nothing to tear down.
    if (!k || !k.scheduler) return;

    // The new logger is not attached yet, so log through the previous one.
    if (typeof k.log === 'function') {
        try {
            k.log('lifecycle', 'script reload: shutting down previous instance');
        } catch (e) { /* logging must not abort the reload */ }
    }

    // shutdown() is the full teardown in current builds; the calls below cover
    // older builds whose shutdown is missing or does less, and are idempotent
    // repeats otherwise.
    if (!callOld(k.lifecycle, 'shutdown')) callOld(k.scheduler, 'stop');
    callOld(k.queue, 'reset');
    if (!callOld(k.ui, 'dispose')) callOld(k.ui, 'stopStatusUpdater');

}(Steward));
