/*
 * Default settings for the collect module.
 *
 * Settings live in host's settings.json under 'steward.collect'.
 * The module's boot() writes these defaults on first run and adds any key
 * the stored settings lack, keeping every stored value.
 */

(function (S) {

    if (!S.modules.collect) S.modules.collect = {};

    S.modules.collect.defaultSettings = {
        // Master switch — when false the module never enqueues anything.
        // Also read by adventures/watcher.js; see adventureZones.
        enabled: true,

        // A building is considered a "pure collectible" if BOTH of:
        //   1. game.def('Collections::CollectionsManager').getBuildingIsCollectible(name) === true
        //      (the host's broad "is harvestable" check — true for collectibles AND
        //      terrain/mines/charcoal piles)
        //   2. its name matches one of these patterns (substring match) OR
        //      one of the active-event base codes (auto-derived in plan()).
        //
        // The default 'Collectible' substring catches DummyBuildingCollectible_*
        // quest items and similar. Active events automatically extend the list:
        // when Easter is live, names containing 'Easter' are picked up
        // (EasterEgg2024, etc.); same for XMAS, Valentine, HW, Soccer,
        // Anniversary. No user action needed for new events as long as
        // Steward.core.events.data has the base code.
        //
        // Use "Discover collectibles" to log candidates if something is
        // still missed.
        //
        // Note: 'Starfall' is intentionally NOT listed — that family lives
        // in a separate module (planned).
        // Also read by adventures/watcher.js; see adventureZones.
        namePatterns: ['Collectible'],

        // Also click on adventure zones: the matching collectibles and the
        // map objects an open quest waits to have clicked. The adventure run
        // reads `enabled`, `adventureZones` and `namePatterns` read-only
        // (adventures/watcher.js patterns()) to decide whether its Pickups
        // step waits for collect; renaming or reshaping any of them must
        // update that reader.
        adventureZones: true
    };

}(Steward));
