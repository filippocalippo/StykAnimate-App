/**
 * Where a person sees and changes what statistics send (docs/STATISTICS.md, "On and off"). Every way there leads through
 * this function: the Help menu's item, the `privacy` command, Home's link and a stykanimate://privacy link. For now it opens
 * Preferences; its Privacy section is built with the statistics' interface.
 */
export function openPrivacy(settings) { return settings?.open(); }
