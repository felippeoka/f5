import CoreGraphics
import ScreenCaptureKit

/// SCStreamConfiguration.backgroundColor is an assign (non-retaining) property.
/// Keep its owner alive until the asynchronous capture has returned or thrown.
public func withComputerCaptureConfiguration<Result>(
  width: Int, height: Int,
  capture: (SCStreamConfiguration) async throws -> Result
) async rethrows -> Result {
  let background = CGColor(gray: 0.45, alpha: 1)
  let configuration = SCStreamConfiguration()
  configuration.width = width
  configuration.height = height
  configuration.showsCursor = false
  configuration.backgroundColor = background
  defer { withExtendedLifetime(background) {} }
  return try await capture(configuration)
}
