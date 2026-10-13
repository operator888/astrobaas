/**
 * ZUGFeRD / Factur-X: an ordinary-looking PDF invoice that carries its
 * EN 16931 XML inside, as a PDF/A-3b document.
 *
 * What PDF/A-3b needs on top of what pdf-lib writes by default, and what this
 * module adds:
 *
 *  - every font embedded (the renderer only ever uses an embedded TTF);
 *  - an XMP metadata stream declaring `pdfaid:part=3`, `conformance=B`, plus
 *    the Factur-X extension schema (`fx:*`) that tells a reader where the XML
 *    is and which profile it follows;
 *  - an OutputIntent with an ICC profile (sRGB2014, bundled unaltered);
 *  - a trailer /ID, and an Info dictionary that agrees with the XMP;
 *  - the XML as an embedded file named `factur-x.xml`, referenced from the
 *    catalog's /AF array with /AFRelationship /Alternative.
 *
 * Verified by extracting the XML back out with the reference `factur-x`
 * Python library; full PDF/A conformance is best confirmed with veraPDF.
 */
import { createHash } from 'node:crypto';
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import { SRGB_ICC_BASE64 } from './srgb-icc';
import { escapeXml } from './format';

export const FACTURX_FILENAME = 'factur-x.xml';

export type FacturxLevel = 'EN 16931' | 'XRECHNUNG';

function xmpDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const xmlEsc = (s: string) => escapeXml(s);

export function buildXmp(opts: {
  title: string; author: string; producer: string; created: Date; facturx?: { level: FacturxLevel };
}): string {
  const date = xmpDate(opts.created);
  const fx = opts.facturx
    ? `
  <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
   <fx:DocumentType>INVOICE</fx:DocumentType>
   <fx:DocumentFileName>${FACTURX_FILENAME}</fx:DocumentFileName>
   <fx:Version>1.0</fx:Version>
   <fx:ConformanceLevel>${opts.facturx.level}</fx:ConformanceLevel>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
   <pdfaExtension:schemas>
    <rdf:Bag>
     <rdf:li rdf:parseType="Resource">
      <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
      <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
      <pdfaSchema:prefix>fx</pdfaSchema:prefix>
      <pdfaSchema:property>
       <rdf:Seq>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The name of the embedded XML document</pdfaProperty:description></rdf:li>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The type of the hybrid document in capital letters, e.g. INVOICE or ORDER</pdfaProperty:description></rdf:li>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The actual version of the standard applying to the embedded XML document</pdfaProperty:description></rdf:li>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The conformance level of the embedded XML document</pdfaProperty:description></rdf:li>
       </rdf:Seq>
      </pdfaSchema:property>
     </rdf:li>
    </rdf:Bag>
   </pdfaExtension:schemas>
  </rdf:Description>`
    : '';
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(opts.title)}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>${xmlEsc(opts.author)}</rdf:li></rdf:Seq></dc:creator>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>${xmlEsc(opts.producer)}</pdf:Producer>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreatorTool>${xmlEsc(opts.producer)}</xmp:CreatorTool>
   <xmp:CreateDate>${date}</xmp:CreateDate>
   <xmp:ModifyDate>${date}</xmp:ModifyDate>
   <xmp:MetadataDate>${date}</xmp:MetadataDate>
  </rdf:Description>${fx}
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * Turn a pdf-lib document into PDF/A-3b, optionally embedding the e-invoice
 * XML. Call after all pages are drawn, before `save()`; then save with
 * `{ useObjectStreams: false, updateMetadata: false }`.
 */
export function makePdfA3(
  doc: PDFDocument,
  opts: { title: string; author: string; created: Date; xml?: string; level?: FacturxLevel },
): void {
  const producer = 'ECWS Billing';
  const ctx = doc.context;

  // Info dictionary — must agree with the XMP.
  doc.setTitle(opts.title, { showInWindowTitleBar: true });
  doc.setAuthor(opts.author);
  doc.setProducer(producer);
  doc.setCreator(producer);
  doc.setCreationDate(opts.created);
  doc.setModificationDate(opts.created);
  doc.setLanguage('de-DE');

  // XMP metadata — uncompressed, as PDF/A requires.
  const xmp = buildXmp({
    title: opts.title, author: opts.author, producer, created: opts.created,
    facturx: opts.xml ? { level: opts.level ?? 'EN 16931' } : undefined,
  });
  const xmpBytes = new TextEncoder().encode(xmp);
  const meta = ctx.stream(xmpBytes, { Type: 'Metadata', Subtype: 'XML', Length: xmpBytes.length });
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(meta));

  // OutputIntent with the sRGB ICC profile.
  const icc = Uint8Array.from(Buffer.from(SRGB_ICC_BASE64, 'base64'));
  const iccStream = ctx.flateStream(icc, { N: 3 });
  const iccRef = ctx.register(iccStream);
  const intent = ctx.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: iccRef,
  });
  doc.catalog.set(PDFName.of('OutputIntents'), ctx.obj([ctx.register(intent)]));

  // Trailer /ID — required by PDF/A.
  const id = createHash('md5').update(`${opts.title}|${opts.created.toISOString()}`).digest('hex');
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);

  if (opts.xml) {
    const xmlBytes = new TextEncoder().encode(opts.xml);
    const params = ctx.obj({
      ModDate: PDFString.fromDate(opts.created),
      Size: PDFNumber.of(xmlBytes.length),
    });
    const ef = ctx.flateStream(xmlBytes, { Type: 'EmbeddedFile', Subtype: 'text/xml', Params: params });
    const efRef = ctx.register(ef);
    const filespec = ctx.obj({
      Type: 'Filespec',
      F: PDFString.of(FACTURX_FILENAME),
      UF: PDFHexString.fromText(FACTURX_FILENAME),
      Desc: PDFString.of('Factur-X / ZUGFeRD invoice'),
      AFRelationship: 'Alternative',
      EF: ctx.obj({ F: efRef, UF: efRef }),
    });
    const fsRef = ctx.register(filespec);
    const names = ctx.obj({ EmbeddedFiles: ctx.obj({ Names: ctx.obj([PDFString.of(FACTURX_FILENAME), fsRef]) }) });
    const existing = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    if (existing) existing.set(PDFName.of('EmbeddedFiles'), (names as PDFDict).get(PDFName.of('EmbeddedFiles'))!);
    else doc.catalog.set(PDFName.of('Names'), names);
    doc.catalog.set(PDFName.of('AF'), ctx.obj([fsRef]) as PDFArray);
  }
}

/**
 * Pull an embedded e-invoice XML out of a PDF (for INCOMING ZUGFeRD invoices).
 * Looks at every embedded file and returns the first that is a CII/UBL XML.
 */
export async function extractEmbeddedXml(pdfBytes: Uint8Array): Promise<string | null> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const ef = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const candidates: PDFDict[] = [];
  const walk = (node: PDFDict | undefined, depth = 0) => {
    if (!node || depth > 8) return;
    const arr = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (arr) for (let i = 1; i < arr.size(); i += 2) {
      const spec = arr.lookupMaybe(i, PDFDict);
      if (spec) candidates.push(spec);
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.lookupMaybe(i, PDFDict), depth + 1);
  };
  walk(ef);
  // Some producers only list it in /AF.
  const af = doc.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
  if (af) for (let i = 0; i < af.size(); i++) {
    const spec = af.lookupMaybe(i, PDFDict);
    if (spec) candidates.push(spec);
  }
  for (const spec of candidates) {
    const efDict = spec.lookupMaybe(PDFName.of('EF'), PDFDict);
    const stream = efDict?.lookup(PDFName.of('F'));
    if (!(stream instanceof PDFRawStream)) continue;
    const bytes = decodePDFRawStream(stream).decode();
    const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
    if (/<(\w+:)?(CrossIndustryInvoice|Invoice|CreditNote)[\s>]/.test(text.slice(0, 4000))) return text;
  }
  return null;
}
