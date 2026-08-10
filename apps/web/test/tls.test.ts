import {
    existsSync,
    mkdtempSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";
import { afterEach, describe, expect, it } from "vitest";
import {
    certificateCovers,
    collectLocalHosts,
    ensureDevCertificate,
    type LocalHosts,
} from "../dev/tls";

/**
 * Certificado del servidor de desarrollo.
 *
 * Lo que se fija aquí: que el certificado cubre la IP por la que realmente se
 * entra desde la LAN, y que se regenera cuando deja de servir — si no, el
 * navegador rechaza la conexión y no hay forma de grabar. Es justo lo que
 * pasa cuando el DHCP cambia la IP de la máquina.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-08T10:00:00.000Z");

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "candidate-process-tls-"));
    dirs.push(dir);
    return dir;
}

/** Certificado de usar y tirar con los SAN que se le pidan. Curva EC: rápida. */
async function certFor(
    hosts: LocalHosts,
    { validDays = 90 }: { validDays?: number } = {},
): Promise<string> {
    const pems = await generate([{ name: "commonName", value: "localhost" }], {
        keyType: "ec",
        algorithm: "sha256",
        notBeforeDate: NOW,
        notAfterDate: new Date(NOW.getTime() + validDays * DAY_MS),
        extensions: [
            {
                name: "subjectAltName",
                altNames: [
                    ...hosts.dns.map((value) => ({ type: 2 as const, value })),
                    ...hosts.ips.map((ip) => ({ type: 7 as const, ip })),
                ],
            },
        ],
    });
    return pems.cert;
}

describe("collectLocalHosts", () => {
    const lan = {
        lo: [
            {
                address: "127.0.0.1",
                family: "IPv4",
                internal: true,
            },
        ],
        wlan0: [
            {
                address: "192.168.1.10",
                family: "IPv4",
                internal: false,
            },
            {
                address: "fe80::1",
                family: "IPv6",
                internal: false,
            },
        ],
    } as unknown as Parameters<typeof collectLocalHosts>[0];

    it("incluye la IP de la LAN, que es por donde se entra desde otro equipo", () => {
        const hosts = collectLocalHosts(lan, "orinoco-dev");

        expect(hosts.ips).toContain("192.168.1.10");
        expect(hosts.ips).toContain("127.0.0.1");
        expect(hosts.dns).toContain("localhost");
        expect(hosts.dns).toContain("orinoco-dev");
        // mDNS: `<nombre>.local` resuelve sin configurar nada.
        expect(hosts.dns).toContain("orinoco-dev.local");
    });

    it("deja fuera IPv6: nadie teclea una IPv6 en la barra de direcciones", () => {
        expect(collectLocalHosts(lan, "orinoco-dev").ips).not.toContain(
            "fe80::1",
        );
    });

    it("no duplica localhost ni inventa un .local sobre un FQDN", () => {
        expect(collectLocalHosts({}, "localhost").dns).toEqual(["localhost"]);
        expect(collectLocalHosts({}, "equipo.casa.lan").dns).toEqual([
            "localhost",
            "equipo.casa.lan",
        ]);
    });

    it("si el hostname ES una IP, va como SAN de IP y no de DNS", () => {
        // El caso de esta máquina: `hostname` devuelve 192.168.1.10. Un SAN
        // de tipo DNS con una IP dentro no lo valida ningún navegador.
        const hosts = collectLocalHosts({}, "192.168.1.10");

        expect(hosts.dns).toEqual(["localhost"]);
        expect(hosts.ips).toContain("192.168.1.10");
    });
});

describe("certificateCovers", () => {
    const hosts: LocalHosts = {
        dns: ["localhost", "orinoco-dev"],
        ips: ["127.0.0.1", "192.168.1.10"],
    };

    it("acepta el certificado que cubre todo y sigue vigente", async () => {
        expect(certificateCovers(await certFor(hosts), hosts, NOW)).toBe(true);
    });

    it("rechaza el que no cubre la IP actual (el caso del DHCP)", async () => {
        const viejo = await certFor({
            dns: hosts.dns,
            ips: ["127.0.0.1", "192.168.1.44"],
        });

        expect(certificateCovers(viejo, hosts, NOW)).toBe(false);
    });

    it("rechaza el que no cubre un nombre nuevo de la máquina", async () => {
        const sinNombre = await certFor({ dns: ["localhost"], ips: hosts.ips });

        expect(certificateCovers(sinNombre, hosts, NOW)).toBe(false);
    });

    it("renueva con margen: a tres días de caducar ya no vale", async () => {
        const casi = await certFor(hosts, { validDays: 3 });

        expect(certificateCovers(casi, hosts, NOW)).toBe(false);
    });

    it("un PEM corrupto no revienta: se regenera", () => {
        const basura = "-----no soy un certificado-----";

        expect(certificateCovers(basura, hosts, NOW)).toBe(false);
    });
});

describe("ensureDevCertificate", () => {
    it("genera el par y guarda la clave privada solo para el dueño", async () => {
        const dir = tempDir();

        const material = await ensureDevCertificate(dir);

        expect(material.cert).toContain("BEGIN CERTIFICATE");
        expect(material.key).toContain("PRIVATE KEY");
        expect(existsSync(join(dir, "web-cert.pem"))).toBe(true);
        // 0600: la clave no la lee el resto de la máquina.
        expect(statSync(join(dir, "web-key.pem")).mode & 0o777).toBe(0o600);
    });

    it("reutiliza el que ya vale, para no invalidar la excepción del navegador", async () => {
        const dir = tempDir();

        const primero = await ensureDevCertificate(dir);
        const segundo = await ensureDevCertificate(dir);

        expect(segundo.cert).toBe(primero.cert);
    });

    it("regenera si el certificado guardado está ilegible", async () => {
        const dir = tempDir();
        const primero = await ensureDevCertificate(dir);
        writeFileSync(join(dir, "web-cert.pem"), "basura");

        const segundo = await ensureDevCertificate(dir);

        expect(segundo.cert).not.toBe("basura");
        expect(segundo.cert).toContain("BEGIN CERTIFICATE");
        expect(segundo.cert).not.toBe(primero.cert);
    });
});
