import Foundation
import XCTest

@testable import ContrarregraKit

/// Núcleo do servidor do runner com um cliente em processo (T-0.5): autenticação (AC-1.2), controlador
/// único (AC-2.5), roteador, métodos de base de S0.5 e desligamento. As ACs medem-se no aparelho na T-0.11;
/// aqui se prova a regra do lado do runner.
final class RunnerServerTests: XCTestCase {
    let auth = RunnerErrorCode.auth.code
    let busy = RunnerErrorCode.busy.code

    // MARK: Autenticação (AC-1.2)

    func testAC12_anyMethodBeforeHelloIsAuthErrorAndClosesTheConnection() throws {
        let server = RunnerHarness()
        for method in ["health", "clock.ping", "runner.capabilities", "runner.shutdown", "ui.tap"] {
            let client = server.client(method)
            let reply = try client.call(method, ["seq": 1])
            XCTAssertEqual(reply.rpcErrorCode, auth, method)
            XCTAssertEqual(reply.rpcIdNumber, 1, method)
            XCTAssertTrue(client.waitClosed(), "\(method): conexão não foi fechada")
        }
        XCTAssertEqual(server.shutdowns.value, 0)
        XCTAssertEqual(server.core.connectionCount, 0)
    }

    func testAC12_wrongTokenIsAuthErrorAndCloses() throws {
        let server = RunnerHarness()
        let token = RunnerHarness.token
        for wrong in [token + "x", String(token.dropLast()), "x" + token.dropFirst(), token.uppercased(), " " + token] {
            let client = server.client()
            let reply = try client.hello(token: wrong)
            XCTAssertEqual(reply.rpcErrorCode, auth, wrong)
            XCTAssertFalse(String(describing: reply).contains(token), "a resposta não ecoa o token")
            XCTAssertTrue(client.waitClosed())
            XCTAssertFalse(server.core.hasController)
        }
    }

    func testAC12_invalidHelloOrNonRequestBeforeHelloIsRejectedAndCloses() throws {
        let server = RunnerHarness()
        let badHellos: [JSONValue] = [
            ["role": "control", "client": [:]],                                       // sem token
            ["token": .string(RunnerHarness.token), "role": "admin", "client": [:]], // papel fora de control|sync
            ["token": .string(RunnerHarness.token), "role": "control"],             // sem client
            ["token": "", "role": "control", "client": [:]],
        ]
        for params in badHellos {
            let client = server.client()
            let reply = try client.call("session.hello", params)
            XCTAssertEqual(reply.rpcErrorCode, auth, "\(params)")
            XCTAssertNotNil(reply["error"]?["data"]?["errors"], "problemas do hello no data")
            XCTAssertTrue(client.waitClosed())
        }

        let garbage = server.client()
        garbage.post("{not json")
        XCTAssertEqual(try garbage.next().rpcErrorCode, -32700)
        XCTAssertTrue(garbage.waitClosed())

        let notification = server.client()
        notification.post(#"{"jsonrpc":"2.0","method":"session.hello","params":{}}"#)
        XCTAssertEqual(try notification.next().rpcErrorCode, auth)
        XCTAssertTrue(notification.waitClosed())

        let response = server.client()
        response.post(#"{"jsonrpc":"2.0","id":1,"result":{}}"#)
        XCTAssertEqual(try response.next().rpcErrorCode, auth)
        XCTAssertTrue(response.waitClosed())
        XCTAssertEqual(server.core.connectionCount, 0)
    }

    // MARK: session.hello (forma de AC-1.1)

    func testAC11_helloAnswersVersionCapabilitiesDeviceAndClockInTheSharedSchema() throws {
        let server = RunnerHarness(allowed: [.px1, .px2, .px3, .px5])
        let client = server.client()
        let before = DeviceClock.rawNs()
        let reply = try client.hello(token: RunnerHarness.token)
        let after = DeviceClock.rawNs()

        let success = try RpcSchema.success(reply, method: "session.hello")
        let result = try SessionHelloResult.decode(success.result)
        XCTAssertEqual(result.runnerVersion, "0.0.0")
        XCTAssertEqual(result.device.screenPt, Size(w: 390, h: 844))
        XCTAssertEqual(try RunnerCapabilities.decode(result.capabilities), server.capabilities)
        XCTAssertGreaterThanOrEqual(result.nowRawNs, Nanos(clamping: before))
        XCTAssertLessThanOrEqual(result.nowRawNs, Nanos(clamping: after))
        XCTAssertFalse(client.isClosed)
        XCTAssertTrue(server.core.hasController)

        XCTAssertNotNil(try client.call("health").rpcResult, "o hello abriu a conexão para os outros métodos")
    }

    func testRepeatedHelloOnAnAuthenticatedConnectionIsInvalidRequest() throws {
        let server = RunnerHarness()
        let client = try server.connected()
        XCTAssertEqual(try client.hello(token: RunnerHarness.token).rpcErrorCode, -32600)
        XCTAssertFalse(client.isClosed)
        XCTAssertNotNil(try client.call("health").rpcResult)
    }

    // MARK: Um controlador por vez (AC-2.5)

    func testAC25_secondControlHelloIsBusyAndClosedWhileTheFirstKeepsWorking() throws {
        let server = RunnerHarness()
        let first = try server.connected(.control, label: "first")
        let second = server.client("second")
        let reply = try second.hello(token: RunnerHarness.token, role: .control)
        XCTAssertEqual(reply.rpcErrorCode, busy)
        XCTAssertTrue(second.waitClosed())
        XCTAssertNotNil(try first.call("health").rpcResult)
    }

    func testControlSlotIsFreedWhenTheControllerDisconnects() throws {
        let server = RunnerHarness()
        let first = try server.connected(.control, label: "first")
        first.disconnect()
        XCTAssertFalse(server.core.hasController)
        let second = try server.connected(.control, label: "second")
        XCTAssertNotNil(try second.call("health").rpcResult)
    }

    func testRejectedHellosDoNotTakeTheControlSlot() throws {
        let server = RunnerHarness()
        let wrong = server.client("wrong")
        XCTAssertEqual(try wrong.hello(token: "nope").rpcErrorCode, auth)
        _ = try server.connected(.control, label: "right")
    }

    func testSyncConnectionsDoNotTakeTheSlotAndCarryOnlyClockPing() throws {
        let server = RunnerHarness()
        let sync1 = try server.connected(.sync, label: "sync1")
        let sync2 = try server.connected(.sync, label: "sync2")
        XCTAssertFalse(server.core.hasController)
        let control = try server.connected(.control, label: "control")

        XCTAssertNotNil(try sync1.call("clock.ping", ["seq": 0]).rpcResult)
        XCTAssertNotNil(try sync2.call("clock.ping", ["seq": 0]).rpcResult)
        for method in ["health", "runner.capabilities", "runner.shutdown"] {
            XCTAssertEqual(try sync1.call(method).rpcErrorCode, auth, method)
        }
        XCTAssertFalse(sync1.isClosed, "a sync autenticada segue aberta")
        XCTAssertEqual(server.shutdowns.value, 0)
        XCTAssertNotNil(try control.call("clock.ping", ["seq": 1]).rpcResult, "a control também leva clock.ping")
    }

    // MARK: Roteador

    func testUnknownMethodIsMethodNotFoundAndSpikeMethodsDoNotExistInProduction() throws {
        let server = RunnerHarness()
        let client = try server.connected()
        for method in ["ui.nope", "spike.echo", "spike.unlockDrag", "ui.tap"] {
            XCTAssertEqual(try client.call(method).rpcErrorCode, -32601, method)
        }
        XCTAssertFalse(client.isClosed)
    }

    func testInvalidParamsAreInvalidParamsWithTheIssues() throws {
        let server = RunnerHarness()
        let client = try server.connected()

        let extra = try client.call("health", ["x": 1])
        XCTAssertEqual(extra.rpcErrorCode, -32602)
        let issues = extra["error"]?["data"]?["errors"]?.arrayValue ?? []
        XCTAssertTrue(issues.contains { $0["path"] == "x" && $0["rule"] == "unknown-field" }, "\(issues)")

        XCTAssertEqual(try client.call("health", nil).rpcErrorCode, -32602, "params obrigatórios nos métodos de base")
        XCTAssertEqual(try client.call("clock.ping", ["pad": "x"]).rpcErrorCode, -32602, "clock.ping sem seq")
    }

    func testDefaultDeadlinesPerCommand() {
        XCTAssertEqual(RpcDeadlines.xctestSeconds(method: "ui.tap", params: nil), 10)
        XCTAssertEqual(RpcDeadlines.xctestSeconds(method: "ui.tree", params: [:]), 5)
        XCTAssertEqual(RpcDeadlines.xctestSeconds(method: "screen.shot", params: [:]), 3)
        XCTAssertEqual(RpcDeadlines.xctestSeconds(method: "wait.for", params: ["timeoutMs": 2500]), 3.5)
        XCTAssertEqual(RpcDeadlines.xctestSeconds(method: "wait.for", params: [:]), 10)

        var router = RpcRouter()
        router.register("ui.tree", lane: .xctest) { _ throws(RpcErrorObject) in .null }
        router.register("choreo.status", lane: .control) { _ throws(RpcErrorObject) in .null }
        XCTAssertEqual(router.route("ui.tree")?.deadline(nil), 5)
        XCTAssertNil(router.route("choreo.status")?.deadline(nil), "a fila de controle não tem prazo")
        XCTAssertEqual(router.route("ui.tree")?.roles, [.control])
    }

    // MARK: Métodos de base

    func testHealthReportsUptimeQueueDepthAndObservedState() throws {
        let server = RunnerHarness()
        server.state.foregroundApp = "com.example.target"
        server.state.treeVersion = 7
        let client = try server.connected()
        let reply = try client.call("health")
        let health = try HealthResult.decode(try RpcSchema.success(reply, method: "health").result)
        XCTAssertTrue(health.ok)
        XCTAssertEqual(health.xctestQueueDepth, 0)
        XCTAssertEqual(health.treeVersion, 7)
        XCTAssertEqual(health.foregroundApp, "com.example.target")
        XCTAssertFalse(health.locked)
        XCTAssertGreaterThanOrEqual(health.uptimeS, 0)
    }

    func testClockPingOnSyncStampsT2AtArrivalAndEchoesThePadSize() throws {
        let server = RunnerHarness()
        let sync = try server.connected(.sync)
        let stamp = ReceiveStamp.now()
        let pad = String(repeating: "é", count: 32_768)  // 65 536 bytes UTF-8: o limite exato de S0.5
        sync.request("clock.ping", ["seq": 41, "pad": .string(pad)], stamp: stamp)
        let reply = try sync.next()
        let after = DeviceClock.rawNs()

        let ping = try ClockPingResult.decode(try RpcSchema.success(reply, method: "clock.ping").result)
        XCTAssertEqual(ping.seq, 41)
        XCTAssertEqual(ping.t2RawNs, Nanos(clamping: stamp.rawNs))
        XCTAssertEqual(ping.t2UptimeNs, Nanos(clamping: stamp.uptimeNs))
        XCTAssertGreaterThanOrEqual(ping.t3RawNs, ping.t2RawNs)
        XCTAssertLessThanOrEqual(ping.t3RawNs, Nanos(clamping: after))
        XCTAssertEqual(ping.pad?.utf8.count, 65_536, "pad ecoado só no tamanho")
        XCTAssertEqual(ping.pad, String(repeating: ".", count: 65_536))

        XCTAssertNil(try sync.call("clock.ping", ["seq": 1]).rpcResult?["pad"], "sem pad, sem eco")

        let tooBig = try sync.call("clock.ping", ["seq": 2, "pad": .string(String(repeating: "x", count: 65_537))])
        XCTAssertEqual(tooBig.rpcErrorCode, -32602)
        let issues = tooBig["error"]?["data"]?["errors"]?.arrayValue ?? []
        XCTAssertTrue(issues.contains { $0["rule"] == "S0.5/pad-max-64KB" }, "\(issues)")
    }

    /// O `clock.ping` de verdade (o tratador de `BaseMethods`), na `sync` e na `control`, responde enquanto um
    /// comando lento ocupa a fila do XCTest: roda fora dela (S1 item 3, S2 item 3). Se a rota fosse para a
    /// fila do XCTest, o ping ficaria atrás do comando lento e não responderia no prazo.
    func testClockPingRunsOffTheXCTestLaneOnSyncAndControl() throws {
        let gate = Gate()
        let server = RunnerHarness(extraRoutes: { router in
            router.register("test.slow", lane: .xctest, deadline: { _ in 30 }) { _ throws(RpcErrorObject) in
                gate.pass(timeout: 10)
                return "slow-done"
            }
        })
        XCTAssertEqual(server.router.route("clock.ping")?.lane, .control)
        XCTAssertEqual(server.router.route("clock.ping")?.roles, [.control, .sync])

        let control = try server.connected(.control, label: "control")
        let sync = try server.connected(.sync, label: "sync")
        let slowId = control.request("test.slow")
        XCTAssertTrue(gate.waitEntered(), "o comando lento ocupa a fila do XCTest")
        defer { gate.release() }

        for (client, seq) in [(sync, 10), (control, 11)] {
            let start = Date()
            let reply = try client.call("clock.ping", ["seq": .number(Double(seq))], timeout: 0.5)
            XCTAssertLessThan(Date().timeIntervalSince(start), 0.2, "clock.ping esperou a fila do XCTest")
            let ping = try ClockPingResult.decode(try RpcSchema.success(reply, method: "clock.ping").result)
            XCTAssertEqual(ping.seq, seq)
        }
        XCTAssertEqual(server.lane.depth, 1, "o comando lento ainda está rodando")

        gate.release()
        let slow = try control.next()
        XCTAssertEqual(slow.rpcIdNumber, slowId)
        XCTAssertEqual(slow.rpcResult, "slow-done")
    }

    /// Mensagem de texto vazia (UTF-8 válido, RFC 6455 §8.1) = texto "": -32700 com `id: null`; a conexão
    /// autenticada segue aberta e com a vaga de controlador; a sem `session.hello` fecha.
    func testEmptyTextIsParseErrorAndKeepsAuthenticatedConnectionsOpen() throws {
        let server = RunnerHarness()
        let control = try server.connected(.control, label: "control")
        let sync = try server.connected(.sync, label: "sync")
        for client in [control, sync] {
            client.post("")
            let reply = try client.next()
            XCTAssertEqual(reply.rpcErrorCode, -32700)
            XCTAssertEqual(reply["id"], .null)
            XCTAssertFalse(client.isClosed)
        }
        XCTAssertTrue(server.core.hasController, "a vaga continua com o controlador")
        XCTAssertNotNil(try control.call("health").rpcResult)
        XCTAssertNotNil(try sync.call("clock.ping", ["seq": 1]).rpcResult)

        let anonymous = server.client("anonymous")
        anonymous.post("")
        XCTAssertEqual(try anonymous.next().rpcErrorCode, -32700)
        XCTAssertTrue(anonymous.waitClosed(), "sem session.hello, fecha como antes")
    }

    /// Como o esquema do Mac (`rpcRequestSchemaFor`): `runner.shutdown` aceita pedido sem `params` ou com
    /// `{}`; `health` e `runner.capabilities` (métodos de base) seguem exigindo `params`.
    func testShutdownAcceptsMissingOrEmptyParamsWhileBaseMethodsRequireThem() throws {
        let server = RunnerHarness()
        let client = try server.connected()
        XCTAssertEqual(try client.call("health", nil).rpcErrorCode, -32602)
        XCTAssertEqual(try client.call("runner.capabilities", nil).rpcErrorCode, -32602)
        XCTAssertEqual(try client.call("runner.shutdown", ["now": true]).rpcErrorCode, -32602, "campo fora de S0")
        XCTAssertEqual(server.shutdowns.value, 0)

        let reply = try client.call("runner.shutdown", nil)
        XCTAssertEqual(reply.rpcResult, .object([:]))
        XCTAssertTrue(client.waitClosed())
        XCTAssertEqual(server.shutdowns.value, 1)

        let other = RunnerHarness()
        let second = try other.connected()
        XCTAssertEqual(try second.call("runner.shutdown", [:]).rpcResult, .object([:]))
        XCTAssertTrue(second.waitClosed())
        XCTAssertEqual(other.shutdowns.value, 1)
    }

    func testAC116_withNoPrivateAllowedEveryPXIsReportedNotAllowed() throws {
        let server = RunnerHarness(present: [.px1, .px2, .px3, .px4, .px5], allowed: [])
        let client = try server.connected()
        let reply = try client.call("runner.capabilities")
        let capabilities = try RunnerCapabilities.decode(try RpcSchema.success(reply, method: "runner.capabilities").result)
        for id in PrivateApiId.allCases {
            XCTAssertEqual(capabilities[id]?.allowed, false, id.rawValue)
        }
        XCTAssertEqual(capabilities[.px1]?.present, true)
        XCTAssertEqual(capabilities[.px6]?.present, false)
        XCTAssertTrue(capabilities.usable.isEmpty)
    }

    func testCapabilitiesReportPresentAndAllowedSeparately() {
        let capabilities = RunnerCapabilities(present: [.px1, .px2, .px3, .px4, .px5], allowed: [.px1, .px2, .px3, .px5, .px6])
        XCTAssertEqual(capabilities[.px6], Capability(present: false, allowed: true))
        XCTAssertEqual(capabilities[.px4], Capability(present: true, allowed: false))
        XCTAssertEqual(capabilities.usable, [.px1, .px2, .px3, .px5])
        XCTAssertEqual(capabilities.capabilities.count, 6, "os seis PX-n sempre no mapa")
    }

    // MARK: Notificações e desligamento

    func testNotificationsGoOnlyToTheController() throws {
        let server = RunnerHarness()
        let log = RpcNotification(method: "log", params: ["level": "warn", "msg": "x"])
        XCTAssertFalse(server.core.notifyController(log), "sem controlador, ninguém recebe")

        let waiting = server.client("waiting")
        let sync = try server.connected(.sync, label: "sync")
        XCTAssertFalse(server.core.notifyController(log))

        let control = try server.connected(.control, label: "control")
        XCTAssertTrue(server.core.notifyController(log))
        let received = try control.next()
        XCTAssertEqual(received["method"], "log")
        XCTAssertNil(received["id"])
        sync.assertSilent(for: 0.1)
        waiting.assertSilent(for: 0.05)
    }

    func testShutdownAnswersFirstThenStopsAndClosesEveryConnection() throws {
        let server = RunnerHarness()
        let sync = try server.connected(.sync, label: "sync")
        let control = try server.connected(.control, label: "control")
        let reply = try control.call("runner.shutdown")
        XCTAssertEqual(reply.rpcResult, .object([:]))
        XCTAssertTrue(control.waitClosed())
        XCTAssertTrue(sync.waitClosed())
        XCTAssertEqual(server.shutdowns.value, 1)

        let late = server.client("late")
        XCTAssertTrue(late.waitClosed(), "depois do shutdown, conexão nova é fechada")
    }
}
