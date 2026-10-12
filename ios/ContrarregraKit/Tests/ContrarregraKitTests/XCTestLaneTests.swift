import Foundation
import XCTest

@testable import ContrarregraKit

/// Agenda das duas filas (S1 item 3) com um cliente em processo: a fila de controle responde enquanto a do
/// XCTest está ocupada (AC-1.12, E-1.2), o prazo responde `E_TIMEOUT` sem travar nada, e um comando vencido
/// ou de conexão fechada não roda depois.
final class XCTestLaneTests: XCTestCase {
    let timeout = RunnerErrorCode.timeout.code

    /// Servidor com `test.slow` (espera o portão), `test.mark` (conta execuções) e `test.overlap` (mede
    /// sobreposição) na fila do XCTest.
    func makeServer(slowDeadline: Double? = 5, markDeadline: Double? = 5, gate: Gate, marks: RunnerHarness.Counter,
                    overlap: OverlapProbe = OverlapProbe()) -> RunnerHarness {
        RunnerHarness(extraRoutes: { router in
            router.register("test.slow", lane: .xctest, deadline: { _ in slowDeadline }) { _ throws(RpcErrorObject) in
                gate.pass()
                return "slow-done"
            }
            router.register("test.mark", lane: .xctest, deadline: { _ in markDeadline }) { _ throws(RpcErrorObject) in
                marks.increment()
                return "marked"
            }
            router.register("test.overlap", lane: .xctest) { _ throws(RpcErrorObject) in
                overlap.run()
                return "ok"
            }
        })
    }

    func testAC112_healthAnswersWithin200msWhileASlowXCTestCommandRuns() throws {
        let gate = Gate()
        let server = makeServer(gate: gate, marks: .init())
        let client = try server.connected()
        let slowId = client.request("test.slow")
        XCTAssertTrue(gate.waitEntered(), "o comando lento começou na fila do XCTest")

        let start = Date()
        let health = try client.call("health", timeout: 0.2)
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.2)
        XCTAssertEqual(health.rpcResult?["xctestQueueDepth"], 1)
        XCTAssertNotNil(try client.call("clock.ping", ["seq": 9], timeout: 0.2).rpcResult)

        gate.release()
        let slow = try client.next()
        XCTAssertEqual(slow.rpcIdNumber, slowId)
        XCTAssertEqual(slow.rpcResult, "slow-done")
        XCTAssertEqual(server.lane.depth, 0)
    }

    func testE12_commandPastItsDeadlineAnswersTimeoutAndTheLateResultIsDropped() throws {
        let gate = Gate()
        let server = makeServer(slowDeadline: 0.1, gate: gate, marks: .init())
        let client = try server.connected()
        let start = Date()
        let slowId = client.request("test.slow")
        XCTAssertTrue(gate.waitEntered())

        let reply = try client.next(timeout: 2)
        let elapsed = Date().timeIntervalSince(start)
        XCTAssertEqual(reply.rpcIdNumber, slowId)
        XCTAssertEqual(reply.rpcErrorCode, timeout)
        XCTAssertEqual(reply["error"]?["data"]?["phase"], "running")
        XCTAssertEqual(reply["error"]?["data"]?["deadlineMs"], 100)
        XCTAssertGreaterThanOrEqual(elapsed, 0.09)
        XCTAssertLessThan(elapsed, 1.0)

        XCTAssertNotNil(try client.call("health", timeout: 0.2).rpcResult, "a fila de controle segue respondendo")
        XCTAssertEqual(server.lane.depth, 1, "o comando ainda ocupa a fila do XCTest")

        gate.release()
        client.assertSilent(for: 0.3)
        XCTAssertEqual(server.lane.depth, 0)
    }

    func testCommandThatTimesOutWhileQueuedNeverRuns() throws {
        let gate = Gate()
        let marks = RunnerHarness.Counter()
        let server = makeServer(slowDeadline: 5, markDeadline: 0.1, gate: gate, marks: marks)
        let client = try server.connected()
        let slowId = client.request("test.slow")
        XCTAssertTrue(gate.waitEntered())
        let markId = client.request("test.mark")

        let expired = try client.next()
        XCTAssertEqual(expired.rpcIdNumber, markId)
        XCTAssertEqual(expired.rpcErrorCode, timeout)
        XCTAssertEqual(expired["error"]?["data"]?["phase"], "queued")
        XCTAssertEqual(server.lane.depth, 2)

        gate.release()
        let slow = try client.next()
        XCTAssertEqual(slow.rpcIdNumber, slowId)
        XCTAssertEqual(slow.rpcResult, "slow-done")
        client.assertSilent(for: 0.2)
        XCTAssertEqual(marks.value, 0, "o comando vencido na fila não roda depois da resposta de erro")
        XCTAssertEqual(server.lane.depth, 0)
    }

    func testQueuedCommandsOfAClosedConnectionNeverRun() throws {
        let gate = Gate()
        let marks = RunnerHarness.Counter()
        let server = makeServer(gate: gate, marks: marks)
        let client = try server.connected()
        client.request("test.slow")
        XCTAssertTrue(gate.waitEntered())
        client.request("test.mark")
        client.request("test.mark")
        let drained = expectation(description: "pedidos entregues")
        client.queue.async { drained.fulfill() }
        wait(for: [drained], timeout: 1)
        client.disconnect()
        XCTAssertFalse(server.core.hasController)

        gate.release()
        let done = expectation(description: "fila do XCTest vazia")
        server.laneQueue.async { done.fulfill() }
        wait(for: [done], timeout: 2)
        XCTAssertEqual(marks.value, 0)
        XCTAssertEqual(server.lane.depth, 0)
    }

    func testXCTestLaneIsSerialAndAnswersEveryCommandOnce() throws {
        let overlap = OverlapProbe()
        let server = makeServer(gate: Gate(), marks: .init(), overlap: overlap)
        let client = try server.connected()
        let ids = (0..<20).map { _ in client.request("test.overlap") }
        var answered: [Int] = []
        for _ in ids { answered.append(try XCTUnwrap(try client.next().rpcIdNumber)) }
        XCTAssertEqual(Set(answered), Set(ids))
        XCTAssertEqual(answered, ids, "fila serial: respostas na ordem de chegada")
        XCTAssertEqual(overlap.maxConcurrent, 1)
        client.assertSilent(for: 0.1)
    }

    func testLaneDepthCountsQueuedAndRunningCommands() {
        let queue = DispatchQueue(label: "test.depth")
        let lane = XCTestLane(queue: queue)
        let gate = Gate()
        let replies = RunnerHarness.Counter()
        for _ in 0..<3 {
            lane.submit(method: "x", deadlineSeconds: nil, shouldRun: { true },
                        work: { gate.pass(); return .success(.null) }, reply: { _ in replies.increment() })
        }
        XCTAssertTrue(gate.waitEntered())
        XCTAssertEqual(lane.depth, 3)
        for _ in 0..<3 { gate.release() }
        XCTAssertTrue(gate.waitEntered())
        XCTAssertTrue(gate.waitEntered())
        let done = expectation(description: "vazia")
        queue.async { done.fulfill() }
        wait(for: [done], timeout: 2)
        XCTAssertEqual(lane.depth, 0)
        XCTAssertEqual(replies.value, 3)
    }
}

/// Mede quantos tratadores rodam ao mesmo tempo.
final class OverlapProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var current = 0
    private var maximum = 0

    func run() {
        lock.withLock {
            current += 1
            maximum = max(maximum, current)
        }
        Thread.sleep(forTimeInterval: 0.002)
        lock.withLock { current -= 1 }
    }

    var maxConcurrent: Int { lock.withLock { maximum } }
}
