import { describe, expect, it } from "vitest";
import { AuditRepository } from "../src/shared/audit";
import { AppError } from "../src/shared/errors";
import { createTestDb } from "./helpers";

describe("AuditRepository (app_event, sobre :memory:)", () => {
    it("registra eventos con metadata de ids/contadores/duraciones", () => {
        const db = createTestDb();
        const audit = new AuditRepository(db);

        const id = audit.logEvent("process.created", "process", "abc", {
            candidateCount: 0,
            durationMs: 12,
        });

        const row = db
            .prepare("SELECT * FROM app_event WHERE id = ?")
            .get(id) as Record<string, unknown>;
        expect(row.action).toBe("process.created");
        expect(row.entity_type).toBe("process");
        expect(row.entity_id).toBe("abc");
        expect(JSON.parse(row.metadata as string)).toEqual({
            candidateCount: 0,
            durationMs: 12,
        });
        expect(typeof row.created_at).toBe("string");
    });

    it("cuenta eventos por acción (base de límites por conteo)", () => {
        const db = createTestDb();
        const audit = new AuditRepository(db);
        audit.logEvent("candidate.analyzed", "candidate", "c1");
        audit.logEvent("candidate.analyzed", "candidate", "c1");
        expect(audit.countByAction("candidate.analyzed")).toBe(2);
        expect(audit.countByAction("export.created")).toBe(0);
    });

    it("rechaza metadata con textos largos (posible contenido sensible)", () => {
        const db = createTestDb();
        const audit = new AuditRepository(db);
        const cvText = "a".repeat(500);
        expect(() =>
            audit.logEvent("cv.extracted", "candidate", "c1", { resumen: cvText }),
        ).toThrow(AppError);
    });

    it("rechaza metadata con valores no primitivos", () => {
        const db = createTestDb();
        const audit = new AuditRepository(db);
        expect(() =>
            audit.logEvent("cv.extracted", "candidate", "c1", {
                // Forzamos un objeto anidado saltándonos el tipo.
                payload: { texto: "..." } as unknown as string,
            }),
        ).toThrow(AppError);
    });
});
