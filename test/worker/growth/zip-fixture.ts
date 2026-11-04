/** Builds small ZIP files (stored or deflated entries) for import tests. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function buildZip(
  files: Array<{ name: string; text: string; deflate?: boolean }>,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = enc.encode(f.text);
    const data = f.deflate ? await deflateRaw(raw) : raw;
    const crc = crc32(raw);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, f.deflate ? 8 : 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, f.deflate ? 8 : 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/** A small but realistic Plausible export (two days). */
export const PLAUSIBLE_FILES = [
  {
    name: "imported_visitors_20240101_20240102.csv",
    text: "date,visitors,pageviews,bounces,visits,visit_duration\n2024-01-01,10,25,4,12,600\n2024-01-02,8,16,2,9,300\n",
  },
  {
    name: "imported_sources_20240101_20240102.csv",
    text:
      "date,source,referrer,utm_source,utm_medium,utm_campaign,utm_content,utm_term,pageviews,visitors,visits,visit_duration,bounces\n" +
      '2024-01-01,Google,,,,,,,15,6,7,400,2\n2024-01-01,,,newsletter,email,"Launch, v2",,,10,4,5,200,2\n',
  },
  {
    name: "imported_pages_20240101_20240102.csv",
    text: "date,hostname,page,visits,visitors,pageviews,exits,time_on_page\n2024-01-01,example.com,/,10,9,20,5,100\n2024-01-01,example.com,/pricing,3,3,5,2,40\n",
  },
  {
    name: "imported_entry_pages_20240101_20240102.csv",
    text: "date,entry_page,visitors,entrances,visit_duration,bounces,pageviews\n2024-01-01,/,9,10,500,3,20\n",
  },
  {
    name: "imported_locations_20240101_20240102.csv",
    text: "date,country,region,city,visitors,visits,visit_duration,bounces,pageviews\n2024-01-01,US,US-CA,5391959,6,7,300,2,15\n2024-01-01,US,US-NY,5128581,2,2,100,1,4\n2024-01-01,DE,,0,2,3,200,1,6\n",
  },
  {
    name: "imported_devices_20240101_20240102.csv",
    text: "date,device,visitors,visits,visit_duration,bounces,pageviews\n2024-01-01,Desktop,7,8,500,2,18\n2024-01-01,Mobile,3,4,100,2,7\n",
  },
  {
    name: "imported_browsers_20240101_20240102.csv",
    text: "date,browser,browser_version,visitors,visits,visit_duration,bounces,pageviews\n2024-01-01,Chrome,120,5,6,300,2,12\n2024-01-01,Chrome,119,1,1,50,0,3\n",
  },
  {
    name: "imported_operating_systems_20240101_20240102.csv",
    text: "date,operating_system,operating_system_version,visitors,visits,visit_duration,bounces,pageviews\n2024-01-01,Mac,14,6,7,400,2,15\n",
  },
  {
    name: "imported_custom_events_20240101_20240102.csv",
    text: "date,name,link_url,path,visitors,events\n2024-01-01,Signup,,,2,2\n",
  },
];
