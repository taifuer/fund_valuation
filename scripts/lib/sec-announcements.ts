import { parse, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];

function nodeText(node: Node): string {
  if ('tagName' in node && ['script', 'style'].includes(node.tagName)) return '';
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(nodeText).join(' ') : '';
}

export function parseSecAnnouncement(body: string, sourceUrl: string) {
  const document = parse(body);
  const text = nodeText(document).replace(/\s+/g, ' ');
  const links: string[] = [];
  const base = new URL(sourceUrl);
  const directory = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
  function walk(node: Node) {
    if ('tagName' in node && node.tagName === 'a') {
      const href = node.attrs.find(attribute => attribute.name === 'href')?.value;
      if (href) {
        try {
          const target = new URL(href, base);
          if (target.origin === base.origin && target.pathname.startsWith(directory)
            && target.pathname !== base.pathname && /\.(?:htm|html)$/i.test(target.pathname)
            && /99[.\-_]?1|earnings|press.?release|results/i.test(`${nodeText(node)} ${target.pathname}`)) {
            links.push(target.href);
          }
        } catch { /* Ignore malformed disclosure links. */ }
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(walk);
  }
  walk(document);
  const earnings = /results of operations and financial condition/i.test(text)
    || /(?:condensed\s+)?consolidated\s+statements?\s+of\s+(?:income|operations|profit|earnings)/i.test(text)
    || /(?:reported|reports|announced)\s+(?:its\s+)?(?:financial\s+)?results\s+for\s+(?:the\s+)?(?:first|second|third|fourth|fiscal|quarter|year)/i.test(text);
  return { earnings, links: [...new Set(links)].slice(0, 2) };
}

export async function probeSecAnnouncement(sourceUrl: string, fetchText: (url: string) => Promise<string>) {
  const page = parseSecAnnouncement(await fetchText(sourceUrl), sourceUrl);
  for (const link of page.links) {
    const exhibit = parseSecAnnouncement(await fetchText(link), link);
    if (exhibit.earnings) return { source: link, evidence: '业绩公告及财务报表附表' };
  }
  return page.earnings ? { source: sourceUrl, evidence: '业绩披露正文，需核验报告期' } : undefined;
}
