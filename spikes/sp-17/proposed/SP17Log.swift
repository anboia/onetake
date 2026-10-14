// PROPOSTA (G5 pendente; não compilado). Destino: ios/ContrarregraRunner/Spikes/SP17Log.swift, registrado em
// `SpikeMethods.register` com `SP17Log.register(into: &router, context)`; entra num build `Spike` novo (G5: editar fora
// dos Files da T-0.37, `runner build --spike` e instalar). Sem API privada, sem pacote novo (CryptoKit é da Apple).
#if SPIKE
import ContrarregraKit
import CryptoKit
import Foundation

/// SP-17 (T-0.37; S4 item 4): o runner escreve um `events.ndjson` de prova no próprio contêiner, linha a linha como o
/// registro de eventos fará, e diz o que escreveu — para o Mac puxar com `devicectl device copy from --domain-type
/// appDataContainer` e conferir o hash com o runner vivo e parado.
///
/// - `spike.logWrite {dir, bytes}` → `{path, bytes, lines, sha256, tDevStartNs, tDevEndNs}`: cria (ou trunca)
///   `Documents/contrarregra/<dir>/events.ndjson`, acrescenta linhas de evento até `bytes` bytes exatos (cada linha um
///   `write` no `FileHandle`, como um registro que cresce), `synchronize()` no fim, e devolve o SHA-256 do arquivo
///   relido do disco. `dir` só `sp17-[a-z0-9-]` (nada fora de `Documents/contrarregra/sp17-*`); `bytes` em 1024…8 MiB.
enum SP17Log {
    static let method = "spike.logWrite"

    static func register(into router: inout RpcRouter, _ context: SpikeMethods.Context) {
        router.register(method, lane: .xctest, deadline: { _ in 30 }) { call throws(RpcErrorObject) in
            let fields = SP3Params.Fields(call.params ?? [:], "params")
            try fields.onlyKeys(["dir", "bytes"])
            guard let dir = try fields.string("dir"), dir.range(of: "^sp17-[a-z0-9-]{1,60}$", options: .regularExpression) != nil else {
                throw SP3Params.invalid("dir: sp17-[a-z0-9-]{1,60}")
            }
            let bytes = try fields.int("bytes", default: 0, 1024...8_388_608)
            return try write(dir: dir, bytes: bytes, clock: context.clock)
        }
    }

    static func write(dir: String, bytes: Int, clock: () -> UInt64) throws(RpcErrorObject) -> JSONValue {
        let start = clock()
        let relative = "Documents/contrarregra/\(dir)/events.ndjson"
        do {
            let docs = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let folder = docs.appendingPathComponent("contrarregra/\(dir)", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("events.ndjson")
            FileManager.default.createFile(atPath: file.path, contents: nil)
            let handle = try FileHandle(forWritingTo: file)
            var total = 0
            var seq = 0
            while total < bytes {
                let head = "{\"schema\":\"contrarregra.events/1\",\"takeId\":\"\(dir)\",\"seq\":\(seq),\"type\":\"step.end\",\"tDevNs\":\"\(clock())\",\"pad\":\""
                let tail = "\"}\n"
                let fixed = head.utf8.count + tail.utf8.count
                let rest = bytes - total
                let want = 200 + (seq % 7) * 13
                let padLen = rest < 2 * (fixed + want) ? rest - fixed : want
                guard padLen >= 0 else { throw SP3Params.invalid("bytes pequeno demais para uma linha") }
                let line = Data((head + String(repeating: "x", count: padLen) + tail).utf8)
                try handle.write(contentsOf: line)
                total += line.count
                seq += 1
            }
            try handle.synchronize()
            try handle.close()
            let data = try Data(contentsOf: file)
            let hex = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            RunnerLog.info("SP-17 logWrite \(relative) \(data.count) B sha256=\(hex)")
            return ["path": .string(relative), "bytes": .number(Double(data.count)), "lines": .number(Double(seq)),
                    "sha256": .string(hex), "tDevStartNs": .string(String(start)), "tDevEndNs": .string(String(clock()))]
        } catch let error as RpcErrorObject {
            throw error
        } catch {
            throw RpcErrorObject(.internalError, "SP-17 logWrite: \(error.localizedDescription)")
        }
    }
}
#endif
