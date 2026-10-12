import Foundation
import XCTest

/// AC-1.14 (parte estática) e P-3/P-4 no `ios/project.yml`: todo bundle id com prefixo
/// `app.kifactory.contrarregra` (o que já deixa de fora o app alvo), time `984PNJZ8B9` explícito,
/// assinatura automática e alvos só de iPhone. A parte dinâmica (`xcodebuild -showBuildSettings`,
/// `codesign -dvv`) é conferida no build.
final class ProjectSpecTests: XCTestCase {
    static let bundlePrefix = "app.kifactory.contrarregra"

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

    func isContrarregraBundleId(_ id: String) -> Bool {
        id == Self.bundlePrefix || id.hasPrefix(Self.bundlePrefix + ".")
    }

    func testAC114_everyBundleIdHasTheContrarregraPrefix() throws {
        let text = try projectText()
        let ids = values(of: "PRODUCT_BUNDLE_IDENTIFIER", in: text)
        XCTAssertEqual(Set(ids), [Self.bundlePrefix, Self.bundlePrefix + ".runner"])
        for id in ids { XCTAssertTrue(isContrarregraBundleId(id), id) }

        // Nenhum outro identificador do mesmo domínio aparece no arquivo (P-4: nenhum alvo do app gravado).
        var rest = Substring(text)
        while let found = rest.range(of: "app.kifactory.") {
            let tail = rest[found.lowerBound...].prefix { !$0.isWhitespace && $0 != "\"" && $0 != "'" }
            XCTAssertTrue(isContrarregraBundleId(String(tail)), "identificador fora do prefixo: \(tail)")
            rest = rest[found.upperBound...]
        }
    }

    func testAC114_eachTargetDeclaresItsOwnContrarregraBundleId() throws {
        let blocks = try targetBlocks(in: try projectText())
        XCTAssertEqual(Set(blocks.keys), ["ContrarregraHost", "ContrarregraRunner"])
        XCTAssertEqual(values(of: "PRODUCT_BUNDLE_IDENTIFIER", in: blocks["ContrarregraHost"] ?? ""), [Self.bundlePrefix])
        XCTAssertEqual(values(of: "PRODUCT_BUNDLE_IDENTIFIER", in: blocks["ContrarregraRunner"] ?? ""), [Self.bundlePrefix + ".runner"])
    }

    func testP3_fixedTeamAndAutomaticSigningAndNoOtherTeam() throws {
        let text = try projectText()
        let teams = values(of: "DEVELOPMENT_TEAM", in: text)
        XCTAssertFalse(teams.isEmpty)
        XCTAssertEqual(Set(teams), ["984PNJZ8B9"])
        XCTAssertEqual(Set(values(of: "CODE_SIGN_STYLE", in: text)), ["Automatic"])
        for other in ["59CB45686C", "V4397KJVXZ", "Apple Distribution", "PROVISIONING_PROFILE"] {
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
