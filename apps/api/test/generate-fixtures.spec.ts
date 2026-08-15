import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildCvDocx } from "../scripts/generate-fixtures";

describe("fixtures de CV", () => {
    it("fija la misma fecha reproducible en todas las entradas del DOCX", async () => {
        const zip = await JSZip.loadAsync(await buildCvDocx());
        const entryDates = new Set(
            Object.values(zip.files).map((entry) => entry.date.getTime()),
        );

        expect(entryDates).toEqual(
            new Set([new Date("2000-01-01T00:00:00.000Z").getTime()]),
        );
    });
});
