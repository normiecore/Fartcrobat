/** A page counts as having no text of its own when it has fewer non-blank characters than this. */
export const ALMOST_NO_TEXT = 20
/** A page counts as a scan when images cover at least this fraction of it (and it has no text). */
export const MOSTLY_IMAGE = 0.6

/** Resolutions offered for recognition (dpi). */
export const DPI_CHOICES = [150, 200, 300, 400, 600] as const
export const DEFAULT_DPI = 300

/** The language bundled with the app. */
export const BUNDLED_LANGUAGE = 'eng'
