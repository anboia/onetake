import Foundation
import XCTest

/// O projeto iOS usa variáveis independentes para os bundles e o time; o build confere a assinatura.
final class ProjectSpecTests: XCTestCase {
    static let hostBundle = "${ONETAKE_HOST_BUNDLE_ID}"
    static let runnerBundle = "${ONETAKE_RUNNER_TEST_BUNDLE_ID}"

    func projectText() throws -> String {
        try Fixtures.text(Fixtures.repoRoot.appending(path: "ios/project.yml"))
    }

    /// Valores de `key:` nas linhas de `text` (sem aspas nem comentário de fim de linha).
    func values(of key: String, in text: some StringProtocol) -> [String] {
        text.split(separator: "\n").compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("\(key):") else { return nil }
            let raw = trimmed.dropFirst(key.count + 1).split(separator: "#", maxSplits: 1).first ?? ""
            return raw.trimmingCharacters(in: .whitespaces.union(.init(charactersIn: "\"'")))
        }
    }

    /// O bloco de cada alvo da seção `targets:` (as linhas com dois espaços de recuo abrem um alvo).
    func targetBlocks(in text: String) throws -> [String: String] {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let start = try XCTUnwrap(lines.firstIndex(of: "targets:"), "project.yml sem targets:")
        var blocks: [String: String] = [:]
        var current: String?
        for line in lines[(start + 1)...] {
            if let first = line.first, first != " ", first != "#" { break }  // a próxima seção do topo
            if line.hasPrefix("  "), !line.hasPrefix("   "), line.hasSuffix(":") {
                current = String(line.dropFirst(2).dropLast())
                blocks[current!] = ""
            } else if let current {
                blocks[current]! += line + "\n"
            }
        }
        return blocks
    }

    func testEachBundleHasItsOwnXcodeGenVariable() throws {
        let text = try projectText()
        let ids = values(of: "PRODUCT_BUNDLE_IDENTIFIER", in: text)
        XCTAssertEqual(Set(ids), [Self.hostBundle, Self.runnerBundle])
        XCTAssertFalse(text.contains("app.kifactory."))
    }

    func testAC114_eachTargetDeclaresItsOwnContrarregraBundleId() throws {
        let blocks = try targetBlocks(in: try projectText())
        XCTAssertEqual(Set(blocks.keys), ["ContrarregraHost", "ContrarregraRunner"])
        XCTAssertEqual(values(of: "PRODUCT_BUNDLE_IDENTIFIER", in: blocks["ContrarregraHost"] ?? ""), [Self.hostBundle])
        XCTAssertEqual(values(of: "PRODUCT_BUNDLE_IDENTIFIER", in: blocks["ContrarregraRunner"] ?? ""), [Self.runnerBundle])
    }

    func testSigningTeamIsInjectedAndHostDisplayNameIsOneTake() throws {
        let text = try projectText()
        let teams = values(of: "DEVELOPMENT_TEAM", in: text)
        XCTAssertFalse(teams.isEmpty)
        XCTAssertEqual(Set(teams), ["${ONETAKE_SIGNING_TEAM}"])
        XCTAssertEqual(Set(values(of: "CODE_SIGN_STYLE", in: text)), ["Automatic"])
        XCTAssertEqual(values(of: "INFOPLIST_KEY_CFBundleDisplayName", in: text), ["OneTake"])
        for other in ["984PNJZ8B9", "Apple Distribution", "PROVISIONING_PROFILE"] {
            XCTAssertFalse(text.contains(other), other)
        }
    }

    /// O preset de iOS do XcodeGen põe `TARGETED_DEVICE_FAMILY = "1,2"` em cada alvo, por cima do valor do
    /// projeto: o "só iPhone" tem de estar em cada alvo.
    func testEveryTargetIsIPhoneOnly() throws {
        let blocks = try targetBlocks(in: try projectText())
        XCTAssertFalse(blocks.isEmpty)
        for (name, block) in blocks {
            XCTAssertEqual(values(of: "TARGETED_DEVICE_FAMILY", in: block), ["1"], name)
        }
    }
}
