import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { ServiceError } from "../x402/paidRoute.js";

const BASE = "https://books.toscrape.com/";
const UA = "GandivaScraper/0.1 (respects robots.txt)";
const RATINGS: Record<string, number> = { One: 1, Two: 2, Three: 3, Four: 4, Five: 5 };

export interface Book {
  title: string;
  price_gbp: number;
  rating: number;
  url: string;
  description: string;
}

let robots: { fetchedAt: number; disallow: string[] } | null = null;

async function allowedByRobots(path: string): Promise<boolean> {
  if (!robots || Date.now() - robots.fetchedAt > 3600_000) {
    const res = await fetch(BASE + "robots.txt", { headers: { "User-Agent": UA } }).catch(() => null);
    const text = res && res.ok ? await res.text() : "";
    const disallow: string[] = [];
    let applies = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.split("#")[0].trim();
      const [k, ...rest] = line.split(":");
      const v = rest.join(":").trim();
      if (/^user-agent$/i.test(k)) applies = v === "*" || UA.toLowerCase().startsWith(v.toLowerCase());
      else if (applies && /^disallow$/i.test(k) && v) disallow.push(v);
    }
    robots = { fetchedAt: Date.now(), disallow };
  }
  return !robots.disallow.some((d) => path.startsWith(d));
}

const pageCache = new Map<number, Book[]>();
const descCache = new Map<string, string>();

async function get(url: string): Promise<string> {
  const path = new URL(url).pathname;
  if (!(await allowedByRobots(path))) throw new ServiceError(`robots.txt disallows ${path}`, 403);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 404) throw new ServiceError(`page not found: ${url}`, 404);
  if (!res.ok) throw new ServiceError(`upstream ${res.status} for ${url}`, 502);
  return res.text();
}

const parsePrice = (s: string) => Number((s.match(/[\d.]+/) ?? ["NaN"])[0]);

async function description(url: string): Promise<string> {
  const hit = descCache.get(url);
  if (hit !== undefined) return hit;
  const $ = cheerio.load(await get(url));
  const d = $("#product_description").next("p").text().trim();
  descCache.set(url, d);
  return d;
}

/** Scrape one catalogue page (20 books) including each book's description from its detail page. */
export async function scrapeCataloguePage(page: number): Promise<Book[]> {
  const cached = pageCache.get(page);
  if (cached) return cached;
  const pageUrl = `${BASE}catalogue/page-${page}.html`;
  const $ = cheerio.load(await get(pageUrl));
  const items = $("article.product_pod")
    .toArray()
    .map((el) => {
      const a = $(el).find("h3 a");
      const ratingClass = ($(el).find("p.star-rating").attr("class") ?? "").split(/\s+/).find((c) => RATINGS[c]);
      return {
        title: a.attr("title") ?? a.text().trim(),
        price_gbp: parsePrice($(el).find(".price_color").text()),
        rating: ratingClass ? RATINGS[ratingClass] : 0,
        url: new URL(a.attr("href") ?? "", pageUrl).toString(),
      };
    });
  if (!items.length) throw new ServiceError(`no books found on page ${page}`, 502);
  const limit = pLimit(8);
  const books = await Promise.all(items.map((b) => limit(async () => ({ ...b, description: await description(b.url) }))));
  pageCache.set(page, books);
  return books;
}
