/*
 * Shared enums.
 *
 * Access path is short and namespaced (Steward.Priority.Normal); the literal
 * value is prefixed (e.g. 'PriorityNormal') so it's unambiguous if it ever
 * appears alone in logs or settings JSON.
 *
 * This file declares the slots. Per-domain enums (Steward.Building,
 * Steward.SpecialistType, …) are populated by their respective core files.
 */

(function (S) {

    S.Priority = {
        Critical: 'PriorityCritical',
        Normal:   'PriorityNormal',
        Idle:     'PriorityIdle'
    };

    // Ordered priority list for scheduler walks (highest first).
    S.kernel.PRIORITY_ORDER = [
        S.Priority.Critical,
        S.Priority.Normal,
        S.Priority.Idle
    ];

    S.kernel.PRIORITY_VALID = {};
    for (var i = 0; i < S.kernel.PRIORITY_ORDER.length; i++) {
        S.kernel.PRIORITY_VALID[S.kernel.PRIORITY_ORDER[i]] = true;
    }

    // Slots for domain enums populated by core files.
    if (!S.Building)            S.Building            = {};
    if (!S.SpecialistType)      S.SpecialistType      = {};
    if (!S.SpecialistStatus)    S.SpecialistStatus    = {};
    if (!S.SkillModifier)       S.SkillModifier       = {};
    if (!S.ExplorerTask)        S.ExplorerTask        = {};
    if (!S.GeologistTask)       S.GeologistTask       = {};
    if (!S.Deposit)             S.Deposit             = {};
    if (!S.TroopClass)          S.TroopClass          = {};    // filled by core/army.js
    if (!S.BattleLine)          S.BattleLine          = {};    // filled by core/battles.js
    if (!S.BattleProblem)       S.BattleProblem       = {};    // filled by core/battles.js

    // Failure kinds of the kernel file API (kernel/17_files.js).
    S.FileError = {
        Missing:     'FileMissing',
        Unreadable:  'FileUnreadable',
        Unwritable:  'FileUnwritable',
        Unavailable: 'FileUnavailable'
    };

    // Where kernel/17_files.js writableDir found a usable folder: the client
    // install directory, the per-app storage directory or the user's documents.
    S.FileLocation = {
        Application: 'FileLocationApplication',
        Storage:     'FileLocationStorage',
        Documents:   'FileLocationDocuments'
    };

    // Log levels, shared by the logger and the low-level notes of
    // kernel/17_files.js. The values are unprefixed on purpose: each one is
    // printed as the [LEVEL] tag of a log line, so prefixing them would change
    // the log format that people and tools read.
    S.LogLevel = {
        Debug: 'DEBUG',
        Log:   'LOG',
        Warn:  'WARN',
        Error: 'ERROR'
    };

    // Per-template speed-buff choices besides a concrete buff name; used by the
    // adventures module. Kernel-level because they carry no TSO knowledge.
    S.SpeedBuffChoice = {
        Default: 'SpeedBuffDefault',
        None:    'SpeedBuffNone'
    };

}(Steward));
