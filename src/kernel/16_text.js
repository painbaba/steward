/*
 * Text helpers.
 *
 * The client stores specialist and camp display names as HTML (bold and font
 * tags, entities such as &amp;). plain() is the one cleaner for those strings:
 * it returns plain text, so the result must be escaped before it reaches an
 * html() sink. Nothing else in the bundle strips markup on its own.
 */

(function (S) {

    var ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', nbsp: ' ' };

    // One pass over the string, so a decoded '&' never starts a second entity.
    function decodeEntity(match, body) {
        if (body.charAt(0) !== '#') {
            return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : match;
        }
        var isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        var code = isHex ? parseInt(body.substring(2), 16) : parseInt(body.substring(1), 10);
        return (code > 0 && code <= 0xFFFF) ? String.fromCharCode(code) : match;
    }

    function plain(html) {
        if (typeof html !== 'string') return '';
        return html
            .replace(/<[^>]+>/g, '')
            .replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, decodeEntity)
            .replace(/[\s\u00A0]+/g, ' ')
            .replace(/^\s+|\s+$/g, '');
    }

    S.kernel.text = { plain: plain };

}(Steward));
