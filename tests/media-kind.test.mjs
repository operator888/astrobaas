#!/usr/bin/env node
/**
 * Media kind, carried rather than guessed.
 *
 * From a production bug on a live shop: a manager uploaded two product
 * videos through the picker. Ingest, storage and delivery were all correct. The
 * product API returned `{ src, alt }` with no type information, the storefront
 * handed the array to next/image, and an .mp4 came back as a broken image with
 * no player. The .mp4 was also eligible to become the JSON-LD `image`, the
 * og:image and the card thumbnail.
 *
 * THE PROPERTY THIS FILE DEFENDS: **a consumer must never have to infer the
 * kind from a filename.** And the subtle half — the previous fix wrote `kind`
 * on SAVE, which made it a fact about when the row was last written rather than
 * about what the file is. A storefront told to trust `kind` would have
 * REGRESSED on every legacy and imported row. So kind is derived on READ, and
 * the tests below assert it against a row that has never been saved.
 *
 * Run with:  node tests/media-kind.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const P = await loadTs('src/lib/product-fields.ts');
const SD = await loadTs('src/lib/structured-data.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* --------------------------------------------- read-time kind, no stored kind */
{
  // A LEGACY row: exactly what the API was serving in production. No `kind`
  // anywhere, because nothing had re-saved the product.
  const legacy = {
    id: 'p1',
    images: [
      { src: '/uploads/2026/06/front.webp', alt: 'Front' },
      { src: '/uploads/2026/06/unboxing.mp4' },
    ],
  };

  const out = P.withMediaKind(legacy);
  check('every entry carries a kind, even with none stored',
    out.images.every((i) => i.kind === 'image' || i.kind === 'video'));
  check('...and the video is identified', out.images[1].kind === 'video');
  check('...and the photo is not', out.images[0].kind === 'image');

  // The separation the owner asked for: a field meaning "a picture" that is
  // structurally incapable of holding a video.
  check('photos holds only photographs', out.photos.length === 1 && out.photos[0].kind === 'image');
  check('videos holds only videos', out.videos.length === 1 && out.videos[0].kind === 'video');
  check('...and photos cannot contain the mp4 at all',
    !out.photos.some((i) => i.src.endsWith('.mp4')));

  // `images` is the WRITE field and must keep every entry, or the admin form
  // loads a product without its videos and deletes them on the next save.
  check('images keeps EVERY entry — it is the write field', out.images.length === 2);
  check('...including the video', out.images.some((i) => i.src.endsWith('.mp4')));
}

/* --------------------------------------------- the media table wins */
{
  const index = P.buildMediaKindIndex([
    { url: '/uploads/a', mime_type: 'video/mp4' },
    { url: '/uploads/b', mime_type: 'image/webp' },
  ]);

  // An extensionless src — the case the extension rule cannot answer at all.
  const out = P.withMediaKind({ images: [{ src: '/uploads/a' }, { src: '/uploads/b' }] }, index);
  check('an extensionless VIDEO is identified from the media table',
    out.images[0].kind === 'video');
  check('...and an extensionless image is not', out.images[1].kind === 'image');
  check('the mime type is published, so a client never has to infer it',
    out.images[0].mime_type === 'video/mp4');

  // mime_type is authoritative over a misleading extension.
  const lying = P.buildMediaKindIndex([{ url: '/uploads/c.webp', mime_type: 'video/mp4' }]);
  check('the media table BEATS the extension when they disagree',
    P.withMediaKind({ images: [{ src: '/uploads/c.webp' }] }, lying).images[0].kind === 'video');

  // A src with no media row — an imported catalogue on someone else's CDN.
  const out2 = P.withMediaKind({ images: [{ src: 'https://cdn.example.com/x.mp4' }] }, index);
  check('a remote src with no media row falls back to the extension',
    out2.images[0].kind === 'video');
  check('...and carries no invented mime type', out2.images[0].mime_type === undefined);
}

/* --------------------------------------------- structured data */
{
  const ctx = { origin: 'https://shop.example.com' };
  const node = SD.productNode({
    name: 'Frame', path: '/p/frame', status: 'active',
    images: ['/uploads/front.webp', '/uploads/clip.mp4'],
    priceCents: 12900, currency: 'EUR',
  }, ctx);

  check('the JSON-LD image array carries the photograph',
    JSON.stringify(node.image).includes('front.webp'));
  /*
   * THE ONE THAT MATTERS, and the reason the filter moved INSIDE the builder.
   * It used to live at the single product route, so any theme, plugin or
   * storefront calling productNode reproduced the bug the route had fixed.
   */
  check('a video NEVER reaches schema.org image',
    !JSON.stringify(node.image ?? []).includes('.mp4'));

  const allVideo = SD.productNode({
    name: 'Frame', path: '/p/f', status: 'active', images: ['/uploads/clip.mp4'],
  }, ctx);
  check('a product whose only media is video emits NO image field, rather than an empty one',
    !('image' in allVideo));

  // Posts: the same gesture on a second content type.
  const article = SD.articleNode({
    title: 'A post', path: '/blog/a', image: '/uploads/clip.mp4',
    published: '2026-01-01', authorName: 'T',
  }, ctx);
  check('a featured VIDEO never becomes BlogPosting.image', !('image' in article));
  const withPhoto = SD.articleNode({
    title: 'A post', path: '/blog/a', image: '/uploads/hero.webp',
    published: '2026-01-01', authorName: 'T',
  }, ctx);
  check('...while a real featured image still does', 'image' in withPhoto);
}

/* --------------------------------------------- write paths keep the kind */
{
  const norm = P.normalizeImages([
    { src: '/uploads/a.webp' },
    { src: '/uploads/b.mp4' },
  ]);
  check('normalizeImages stamps video on save', norm[1].kind === 'video');
  check('...and leaves a photo unstamped, so stored bytes do not change',
    norm[0].kind === undefined);

  // A variant image feeds the cart line's <img>; a video there is a broken
  // basket thumbnail, and there is no admin UI to catch it.
  const v = P.normalizeVariants(
    [{ options: { Colour: 'Black' }, image: '/uploads/clip.mp4' }], undefined, undefined,
  );
  check('a VARIANT image refuses a video', v[0].image === undefined);
  const v2 = P.normalizeVariants(
    [{ options: { Colour: 'Black' }, image: '/uploads/black.webp' }], undefined, undefined,
  );
  check('...while a real variant photo survives', v2[0].image === '/uploads/black.webp');
}

/* --------------------------------------------- mainImage still skips video */
{
  const imgs = [{ src: '/uploads/clip.mp4', kind: 'video' }, { src: '/uploads/p.webp' }];
  check('mainImage skips a leading video, so listings never show a broken thumb',
    P.mainImage(imgs)?.src === '/uploads/p.webp');
  check('...and returns undefined when the gallery is ALL video',
    P.mainImage([{ src: '/uploads/clip.mp4' }]) === undefined);
}

/* --------------------------------------------- poster frames (no ffmpeg) */
{
  // Requirement 5: an editor nominates an existing image; nothing is decoded.
  const out = P.withMediaKind({ images: [
    { src: '/uploads/front.webp' },
    { src: '/uploads/tour.mp4' },
  ] });
  check('a video is given a poster without anyone nominating one',
    out.images[1].poster === '/uploads/front.webp');
  check('...taken from the first PHOTOGRAPH, so a client renders <video poster> at once',
    out.videos[0].poster === '/uploads/front.webp');
  check('a photograph never carries a poster — it would invite rendering the wrong one',
    out.images[0].poster === undefined);
  // Stripped on READ, not merely never written: `normalizeImages` refuses to
  // store one, but a legacy row, an import or a hand-edited database can carry
  // it, and the reader is what every consumer actually sees.
  const strayed = P.withMediaKind({ images: [
    { src: '/uploads/a.webp', poster: '/uploads/b.webp' },
    { src: '/uploads/c.mp4' },
  ] });
  check('...and a stored poster on a photograph is STRIPPED on read',
    strayed.images[0].poster === undefined);
  check('...while the video beside it keeps its own',
    strayed.images[1].poster === '/uploads/a.webp');

  // The editor's choice beats the fallback.
  const chosen = P.withMediaKind({ images: [
    { src: '/uploads/front.webp' },
    { src: '/uploads/side.webp' },
    { src: '/uploads/tour.mp4', poster: '/uploads/side.webp' },
  ] });
  check('a nominated poster wins over the first photo',
    chosen.images[2].poster === '/uploads/side.webp');

  // A gallery led by the video must not poster the video with itself.
  const videoFirst = P.withMediaKind({ images: [
    { src: '/uploads/tour.mp4' },
    { src: '/uploads/front.webp' },
  ] });
  check('a gallery that STARTS with the video still finds a photograph',
    videoFirst.images[0].poster === '/uploads/front.webp');
  check('...and never posters a video with a video',
    !String(videoFirst.images[0].poster).endsWith('.mp4'));

  const allVideo = P.withMediaKind({ images: [{ src: '/uploads/tour.mp4' }] });
  check('a gallery with no photograph gets NO poster, rather than an invented one',
    allVideo.images[0].poster === undefined);

  // Storage rules.
  const saved = P.normalizeImages([
    { src: '/uploads/clip.mp4', poster: '/uploads/still.webp' },
    { src: '/uploads/photo.webp', poster: '/uploads/still.webp' },
    { src: '/uploads/b.mp4', poster: '/uploads/other.mp4' },
    { src: '/uploads/c.mp4', poster: 'javascript:alert(1)' },
  ]);
  check('a nominated poster is stored on a video', saved[0].poster === '/uploads/still.webp');
  check('a poster on a PHOTOGRAPH is refused — it means nothing there',
    saved[1].poster === undefined);
  check('a VIDEO nominated as a poster is refused — <video poster> renders nothing',
    saved[2].poster === undefined);
  check('a hostile scheme is refused as a poster, exactly as for a src',
    saved[3].poster === undefined);
}

/* --------------------------------------------- posts have the same hole */
{
  const MK = await loadTs('src/lib/media-kind.ts');

  const withVideo = MK.withFeaturedMediaKind({ title: 'A', featured_image: '/uploads/clip.mp4' });
  check('a post says what its featured media IS', withVideo.featured_media?.kind === 'video');
  check('...and featured_photo is ABSENT, so a thumbnail cannot render the mp4',
    withVideo.featured_photo === undefined);
  check('...while featured_video gives a player somewhere honest to look',
    withVideo.featured_video === '/uploads/clip.mp4');
  check('the stored write field is untouched, so an editor form round-trips',
    withVideo.featured_image === '/uploads/clip.mp4');

  const withPhoto = MK.withFeaturedMediaKind({ featured_image: '/uploads/hero.webp' });
  check('a photo post exposes featured_photo', withPhoto.featured_photo === '/uploads/hero.webp');
  check('...and no featured_video', withPhoto.featured_video === undefined);

  // "No featured image" and "a featured image that is a video" must stay
  // distinguishable — a caller collapsing them renders an empty <img>.
  const none = MK.withFeaturedMediaKind({ title: 'A' });
  check('a post with no featured image gains no fields at all',
    none.featured_media === undefined && !('featured_photo' in none));
  check('...and an empty string counts as none, not as a photo',
    MK.withFeaturedMediaKind({ featured_image: '   ' }).featured_media === undefined);

  // The media table wins here too.
  const index = MK.buildMediaKindIndex([{ url: '/uploads/x', mime_type: 'video/mp4' }]);
  const extless = MK.withFeaturedMediaKind({ featured_image: '/uploads/x' }, index);
  check('an extensionless featured video is caught by the media table',
    extless.featured_media?.kind === 'video' && extless.featured_photo === undefined);
  check('...and its mime type is published', extless.featured_media?.mime_type === 'video/mp4');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
