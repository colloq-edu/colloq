/**
 * Сборка публичной страницы из того, что записала комната.
 *
 * Здесь два обещания, и оба держатся перечислением, а не вычитанием.
 *
 * ЧТО ПОПАДАЕТ НАРУЖУ — белый список полей. У документа четыре корня, и
 * тетрадь только один из них: `chat` несёт имена всех, кто спрашивал оракула,
 * `terminal` — всё, что кто-нибудь напечатал в оболочку. Внутри ячейки то же
 * самое: `runBy` и `runById` стоят на каждой запущенной. Поле, добавленное в
 * тетрадь завтра, не должно оказаться на публичной странице само собой —
 * поэтому список полей здесь написан буквами.
 *
 * ЧТО МОЖЕТ БЫТЬ ШАГОМ — только версия, которая разворачивается хотя бы в одну
 * ячейку. Это не осторожность: у комнат, записанных старой сборкой, база
 * истории снята с пустого документа, и всё до починки разворачивается в ноль.
 * Пустая страница у студента невозможна не потому, что о ней позаботились, а
 * потому, что такой шаг не собирается.
 */
import { createHash } from "node:crypto";
import * as Y from "yjs";
import {
  readNotebook,
  type CellOutput,
  type CellSnapshot,
} from "@shared/notebook";
import { BLOB_MIN_BYTES, BLOB_PREFIX, type PublicCell } from "@shared/publish";
import { updatesUpTo } from "../db.js";

/** Крупные куски выводов, вынесенные по хэшу. Наполняется по ходу сборки. */
export interface BlobBag {
  put(mime: string, base64: string): string;
  all(): { hash: string; mime: string; body: Buffer }[];
}

export function newBlobBag(): BlobBag {
  const seen = new Map<string, { mime: string; body: Buffer }>();
  return {
    put(mime, base64) {
      const body = Buffer.from(base64, "base64");
      const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
      if (!seen.has(hash)) seen.set(hash, { mime, body });
      return `${BLOB_PREFIX}${hash}`;
    },
    all() {
      return [...seen].map(([hash, v]) => ({
        hash,
        mime: v.mime,
        body: v.body,
      }));
    },
  };
}

/**
 * Вывод в том виде, в каком он ляжет на страницу.
 *
 * Крупное содержимое уезжает в отдельную запись: график matplotlib — это
 * base64 на сотни килобайт, одинаковый во всех шагах, где его ячейка не
 * менялась. Шесть шагов давали бы шесть копий одной картинки.
 */
function projectOutput(output: CellOutput, blobs: BlobBag): CellOutput {
  if (output.kind !== "data") return output;
  const data: Record<string, string> = {};
  for (const [mime, value] of Object.entries(output.data)) {
    data[mime] =
      typeof value === "string" &&
      value.length >= BLOB_MIN_BYTES &&
      mime.startsWith("image/")
        ? blobs.put(mime, value)
        : value;
  }
  return { ...output, data };
}

/** Ячейка на публичной странице. Белый список — см. шапку файла. */
function projectCell(cell: CellSnapshot, blobs: BlobBag): PublicCell {
  return {
    id: cell.id,
    type: cell.type,
    source: cell.source,
    outputs: cell.outputs.map((o) => projectOutput(o, blobs)),
    /*
     * Номер выполнения переносится как есть, включая `null` при непустом
     * выводе. Это не пропуск данных, а факт: результат на экране есть, а
     * выполнения, которое за него отвечает, уже нет — перезапускали ядро или
     * возвращали версию. Страница говорит про это «Out [—]», и врать здесь
     * хуже, чем промолчать.
     */
    execCount: cell.execCount,
    ranMs: cell.ranMs,
  };
}

/** Тетрадь на момент версии `seq`, спроецированная для публикации. */
export function pageAt(
  sessionId: string,
  seq: number,
  blobs: BlobBag,
): PublicCell[] | null {
  const doc = new Y.Doc();
  try {
    doc.transact(() => {
      for (const update of updatesUpTo(sessionId, seq))
        Y.applyUpdate(doc, update, "publish");
    });
    const cells = readNotebook(doc);
    if (cells.length === 0) return null;
    return cells.map((c) => projectCell(c, blobs));
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}

/** Тетрадь как она есть прямо сейчас — последняя страница публикации. */
export function pageOfDoc(doc: Y.Doc, blobs: BlobBag): PublicCell[] {
  return readNotebook(doc).map((c) => projectCell(c, blobs));
}
