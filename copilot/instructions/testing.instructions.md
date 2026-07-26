---
description: Rules and best practices for writing high quality tests. Read before authoring or updating tests.
applyTo: '**'
---

# Writing high-value tests

Write each test so it can fail for a real reason. A test that cannot fail when the behavior breaks, or that passes when the behavior is absent, costs maintenance and proves nothing. Faking green is worse than no test: a disabled test, a swallowed exception, an unwarranted retry, or a sleep that masks a race reports a safety that is not there. Every rule below serves that bar.

## Test behavior, not wiring

Assert observable outcomes: given this input, does the system produce the right output; with the feature off, does nothing happen? A test that a constructor set a property, that DI resolved, or that a mock was called proves the code is connected, not that it works.

## Prove the test can fail

Assert the precondition before the action, so a pass means something. Before a state transition, assert the starting state; when the test turns on boundary data, assert where that data sits relative to the boundary. Skip this and the test passes vacuously the day a constant shifts or setup drifts. Mutation testing (Stryker) checks this mechanically: it breaks the code and confirms a test starts failing. If you break it by hand instead, confirm the passing run afterward tests the restored code and not a leftover build of the broken version.

```csharp
// Assert both sides of a transition
context.Outcome.Should().BeOfType<SessionOutcome.Retry>("precondition: default is Retry");
context.Complete();
context.Outcome.Should().BeOfType<SessionOutcome.Completed>();

// Prove the boundary data sits where you think
var input = TimeSpan.FromSeconds(10);
input.Should().BeLessThan(MinTimeout, "precondition: below the minimum");
```

## Use real infrastructure, not mocks of the thing under test

Prefer containers, emulators, and in-memory databases over mocking the system under test: a mock of the code you are testing can only confirm your assumptions, never catch a bug. Mocks belong on the edges, collecting output (in-memory exporters, recorded lists), not standing in for the subject.

## Keep each test isolated

A test owns its data and resources and cleans up after itself, so running it alone, in a different order, or in parallel gives the same result. Shared state - a leaked row, a fixed port, a static singleton - makes tests fail for reasons unrelated to the behavior, and a test that cries wolf gets ignored.

## Exercise where bugs live

Feed realistic data - real log lines, query strings, wire formats - not minimal synthetic strings that skip the hard parts. Cover the boundaries (valid, the exact limit, one past it, malformed, empty or null) and the alternative formats (IPv6, HTTP against HTTPS). Give every feature at least one negative-path test: feature off, input invalid, operation failed. Bugs cluster at these edges, so that is where tests pay off. When an invariant matters more than any single case, let property-based testing (FsCheck, Hypothesis) generate the inputs and assert the invariant holds across them.

## Let the tests document behavior

A parameterized test carries more than coverage: a `[Theory]` with `[InlineData]` or `[MemberData]` reads as living documentation, so annotate the non-obvious cases. When a `[Fact]` feeds one hardcoded value to data-driven code, promote it to a `[Theory]` with several, or the implementation can pass by echoing that single literal. For multi-property output, snapshot with Verify instead of dozens of assertions, and scrub the non-deterministic values. A snapshot earns its keep only if you read the diff and approve it deliberately; rubber-stamping the received output into the verified baseline is another way to write a test that cannot fail.

## Test what ships, at the right layer

Exercise the surface a consumer touches - the same DI extensions, builders, and configuration they would write in `Program.cs`. Match the layer to the risk: millisecond unit tests for logic, integration tests on real infrastructure for wiring, without collapsing everything into one. Keep helpers small and named; an elaborate base class hides what the test actually does.
