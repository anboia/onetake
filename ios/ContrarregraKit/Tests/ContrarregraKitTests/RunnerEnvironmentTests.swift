import Foundation
import XCTest

@testable import ContrarregraKit

/// Variáveis de ambiente do runner (S1 "API / Interface", S2 item 1) e os nomes dos traços do aparelho.
final class RunnerEnvironmentTests: XCTestCase {
    let token = "tok-3f9a1c7e5b2d4086a1e9c3b5d7f0a2c4"

    func testReadsPortTokenSessionAndPrivateAllowed() throws {
        let env = try RunnerEnvironment.read([
            "CONTRARREGRA_PORT": "8711",
            "CONTRARREGRA_TOKEN": token,
            "CONTRARREGRA_SESSION": "20261012-101500",
            "CONTRARREGRA_PRIVATE": "PX-1,PX-2, PX-3 PX-5,PX-9",
            "CONTRARREGRA_ALLOWED": "com.example.target",
        ], allowBindOverride: false)
        XCTAssertEqual(env.port, 8711)
        XCTAssertEqual(env.token, token)
        XCTAssertEqual(env.session, "20261012-101500")
        XCTAssertEqual(env.privateAllowed, [.px1, .px2, .px3, .px5])
        XCTAssertEqual(env.unknownPrivate, ["PX-9"])
        XCTAssertEqual(env.bind, .loopback)
        XCTAssertFalse(env.bindIgnored)
    }

    func testDefaultsAreLoopbackPort8700AndNoPrivateApi() throws {
        let env = try RunnerEnvironment.read(["CONTRARREGRA_TOKEN": token, "CONTRARREGRA_PRIVATE": ""], allowBindOverride: false)
        XCTAssertEqual(env.port, 8700)
        XCTAssertEqual(env.privateAllowed, [])
        XCTAssertNil(env.session)
        XCTAssertEqual(env.bind, .loopback)
    }

    func testMissingOrEmptyTokenRefusesToServe() {
        for environment in [[:], ["CONTRARREGRA_TOKEN": ""], ["CONTRARREGRA_PORT": "8700"]] as [[String: String]] {
            XCTAssertThrowsError(try RunnerEnvironment.read(environment, allowBindOverride: true)) { error in
                XCTAssertEqual(error as? RunnerEnvironment.Failure, .missingToken)
            }
        }
    }

    func testRejectsPortsOutsideOneTo65535() {
        for raw in ["0", "65536", "87a", "-1", "", "8700.0", "+8700"] {
            XCTAssertThrowsError(try RunnerEnvironment.read(["CONTRARREGRA_TOKEN": token, "CONTRARREGRA_PORT": raw],
                                                            allowBindOverride: false), raw) { error in
                XCTAssertEqual(error as? RunnerEnvironment.Failure, .badPort(raw))
            }
        }
        XCTAssertEqual(try RunnerEnvironment.read(["CONTRARREGRA_TOKEN": token, "CONTRARREGRA_PORT": "65535"],
                                                  allowBindOverride: false).port, 65_535)
    }

    func testBindChoiceOnlyInTheSpikeBuild() throws {
        let endpoint = ["CONTRARREGRA_TOKEN": token, "CONTRARREGRA_BIND": "endpoint"]
        XCTAssertEqual(try RunnerEnvironment.read(endpoint, allowBindOverride: true).bind, .endpoint)
        XCTAssertEqual(try RunnerEnvironment.read(["CONTRARREGRA_TOKEN": token, "CONTRARREGRA_BIND": "loopback"],
                                                  allowBindOverride: true).bind, .loopback)

        let production = try RunnerEnvironment.read(endpoint, allowBindOverride: false)
        XCTAssertEqual(production.bind, .loopback, "fora do build Spike, sempre a interface de loopback")
        XCTAssertTrue(production.bindIgnored)

        XCTAssertThrowsError(try RunnerEnvironment.read(["CONTRARREGRA_TOKEN": token, "CONTRARREGRA_BIND": "0.0.0.0"],
                                                        allowBindOverride: true)) { error in
            XCTAssertEqual(error as? RunnerEnvironment.Failure, .badBind("0.0.0.0"))
        }
    }

    /// T-0.6: a lista permitida vem de `CONTRARREGRA_ALLOWED` (vírgula e/ou espaço, como o PRIVATE) e
    /// `CONTRARREGRA_EXPLORE`.
    func testReadsAllowedListAndExploreApp() throws {
        let env = try RunnerEnvironment.read([
            "CONTRARREGRA_TOKEN": token,
            "CONTRARREGRA_ALLOWED": "com.example.notes, example://  https://example.com/,,com.example.maps",
            "CONTRARREGRA_EXPLORE": " com.example.target ",
        ], allowBindOverride: false)
        XCTAssertEqual(env.allowed, ["com.example.notes", "example://", "https://example.com/", "com.example.maps"])
        XCTAssertEqual(env.explore, "com.example.target")
        XCTAssertTrue(env.description.contains("explore=com.example.target"), env.description)

        let empty = try RunnerEnvironment.read(["CONTRARREGRA_TOKEN": token, "CONTRARREGRA_ALLOWED": " ", "CONTRARREGRA_EXPLORE": ""],
                                               allowBindOverride: false)
        XCTAssertEqual(empty.allowed, [])
        XCTAssertNil(empty.explore)
        XCTAssertNil(try RunnerEnvironment.read(["CONTRARREGRA_TOKEN": token], allowBindOverride: false).explore)
    }

    func testDescriptionAndErrorsNeverCarryTheToken() throws {
        let env = try RunnerEnvironment.read(["CONTRARREGRA_TOKEN": token, "CONTRARREGRA_PRIVATE": "PX-3,PX-1"],
                                             allowBindOverride: false)
        XCTAssertFalse(env.description.contains(token))
        XCTAssertTrue(env.description.contains("private=[PX-1,PX-3]"), env.description)
        for failure in [RunnerEnvironment.Failure.missingToken, .badPort("x"), .badBind("y")] {
            XCTAssertFalse(failure.description.contains(token))
        }
    }

    // MARK: Traços do aparelho (S0.5 device)

    func testTextSizeNamesFromContentSizeCategory() {
        XCTAssertEqual(DeviceTraits.textSize(contentSizeCategory: "UICTContentSizeCategoryL"), "large")
        XCTAssertEqual(DeviceTraits.textSize(contentSizeCategory: "UICTContentSizeCategoryXXXL"), "extraExtraExtraLarge")
        XCTAssertEqual(DeviceTraits.textSize(contentSizeCategory: "UICTContentSizeCategoryAccessibilityM"), "accessibilityMedium")
        XCTAssertEqual(DeviceTraits.textSize(contentSizeCategory: "SomethingNew"), "SomethingNew")
    }

    func testLanguageCodeAndOsDescription() {
        XCTAssertEqual(DeviceTraits.languageCode(preferred: "en-US"), "en")
        XCTAssertEqual(DeviceTraits.languageCode(preferred: "pt-BR"), "pt")
        XCTAssertEqual(DeviceTraits.languageCode(preferred: "en"), "en")
        XCTAssertEqual(DeviceTraits.languageCode(preferred: nil), "und")
        XCTAssertEqual(DeviceTraits.osDescription(version: "26.3", build: "23D127"), "26.3 (23D127)")
        XCTAssertEqual(DeviceTraits.osDescription(version: "26.3", build: nil), "26.3")
    }
}
