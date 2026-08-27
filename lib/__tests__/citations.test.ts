import { describe, it, expect } from "vitest";
import {
  normUrl,
  rewriteCitations,
  rewriteCitationsInParts,
  hostnameOf,
  kbKey,
  quoteAppearsIn,
  claimSupported,
} from "@/lib/citations";

describe("normUrl", () => {
  it("lowercases and strips trailing slashes", () => {
    expect(normUrl("https://Example.com/Path/")).toBe("https://example.com/path");
    expect(normUrl("https://example.com///")).toBe("https://example.com");
    expect(normUrl("https://example.com/a")).toBe("https://example.com/a");
  });
});

describe("rewriteCitations", () => {
  it("renumbers sequentially by first appearance, ignoring the model's numbers", () => {
    const input =
      "A [[3]](https://a.com/x). B [[7]](https://b.com/y). A again [[3]](https://a.com/x).";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toBe(
      "A [[1]](https://a.com/x). B [[2]](https://b.com/y). A again [[1]](https://a.com/x)."
    );
    expect(orderedUrls).toEqual(["https://a.com/x", "https://b.com/y"]);
  });

  it("gives the same number to case/slash variants of the same URL", () => {
    const input =
      "One [[1]](https://Example.com/Page/). Two [[2]](https://example.com/page).";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toBe(
      "One [[1]](https://Example.com/Page/). Two [[1]](https://example.com/page)."
    );
    expect(orderedUrls).toEqual(["https://Example.com/Page/"]);
  });

  it("strips bare [[N]] citations without a link, swallowing one space", () => {
    const input = "[[2]] Daniel's research is important [[5]] and rigorous.";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toBe("Daniel's research is important and rigorous.");
    expect(orderedUrls).toEqual([]);
  });

  it("leaves no stray space before punctuation when stripping debris", () => {
    const input =
      "Professor at WU Vienna [[2]] , on break. Cited work (2016, 136 citations) [[4]] .";
    const { text } = rewriteCitations(input);
    expect(text).toBe(
      "Professor at WU Vienna, on break. Cited work (2016, 136 citations)."
    );
  });

  it("collapses placeholder citations before punctuation cleanly", () => {
    const input = "He received awards [[3]](no URL available) .";
    const { text } = rewriteCitations(input);
    expect(text).toBe("He received awards.");
  });

  it("strips malformed citations with placeholder link targets", () => {
    const input =
      "Praised his clarity. [[1]](no URL available) He received two awards. [[3]](no URL available)";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toBe("Praised his clarity. He received two awards. ");
    expect(orderedUrls).toEqual([]);
  });

  it("keeps valid citations while stripping placeholder-target ones", () => {
    const input =
      "Real [[2]](https://a.com) and fake [[1]](no URL available) here.";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toBe("Real [[1]](https://a.com) and fake here.");
    expect(orderedUrls).toEqual(["https://a.com"]);
  });

  it("keeps valid citations while stripping bare ones", () => {
    const input = "Real [[9]](https://a.com) but debris [[4]] here.";
    const { text } = rewriteCitations(input);
    expect(text).toBe("Real [[1]](https://a.com) but debris here.");
  });

  it("preserves original URL casing (URLs can be case-sensitive)", () => {
    const input = "See [[1]](https://scholar.google.com/citations?user=ExAmpleId42).";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toContain("https://scholar.google.com/citations?user=ExAmpleId42");
    expect(orderedUrls[0]).toBe(
      "https://scholar.google.com/citations?user=ExAmpleId42"
    );
  });

  it("does not renumber non-http(s) schemes and never lists them", () => {
    const input = "Bad [[1]](javascript:alert(1)). Good [[2]](https://a.com).";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(orderedUrls).toEqual(["https://a.com"]);
    expect(text).toContain("[[1]](https://a.com)");
  });

  it("accepts single-bracket citation drift [N](url) and canonicalizes it", () => {
    const input = "Finding [2](https://b.com/x) and [7](https://a.com/y).";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toBe(
      "Finding [[1]](https://b.com/x) and [[2]](https://a.com/y)."
    );
    expect(orderedUrls).toEqual(["https://b.com/x", "https://a.com/y"]);
  });

  it("accepts a space between [[N]] and the URL parens", () => {
    const input = "Claim [[3]] (https://a.com).";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toBe("Claim [[1]](https://a.com).");
    expect(orderedUrls).toEqual(["https://a.com"]);
  });

  it("leaves plain markdown links and images untouched", () => {
    const input =
      "Plain [link text](https://a.com) and image ![1](https://img.example.com/f.png).";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toBe(input);
    expect(orderedUrls).toEqual([]);
  });

  it("returns text unchanged when there are no citations", () => {
    const input = "No citations here.";
    expect(rewriteCitations(input)).toEqual({
      text: input,
      orderedUrls: [],
      citations: [],
    });
  });
});

describe("citation quotes (verification support)", () => {
  it("captures quotes and strips them from the displayed text", () => {
    const input =
      'Claim one [[1]](https://a.com "exact words from source"). Claim two [[2]](https://b.com "other words").';
    const { text, citations } = rewriteCitations(input);
    expect(text).toBe(
      "Claim one [[1]](https://a.com). Claim two [[2]](https://b.com)."
    );
    expect(citations).toEqual([
      { url: "https://a.com", quotes: ["exact words from source"], claims: [] },
      { url: "https://b.com", quotes: ["other words"], claims: [] },
    ]);
  });

  it("gathers multiple quotes for repeat citations of one source", () => {
    const input =
      'A [[1]](https://a.com "first quote"). B [[1]](https://a.com "second quote").';
    const { citations } = rewriteCitations(input);
    expect(citations).toEqual([
      { url: "https://a.com", quotes: ["first quote", "second quote"], claims: [] },
    ]);
  });

  it("captures quotes on kb: citations and renders them unlinked", () => {
    const input = 'KB fact [[2]](kb:Teaching-Statement "student empowerment").';
    const { text, citations } = rewriteCitations(input);
    expect(text).toBe("KB fact [1].");
    expect(citations).toEqual([
      { url: "kb:Teaching-Statement", quotes: ["student empowerment"], claims: [] },
    ]);
  });

  it("citations without quotes still parse, with empty quote lists", () => {
    const input = "Old style [[1]](https://a.com).";
    const { citations } = rewriteCitations(input);
    expect(citations).toEqual([{ url: "https://a.com", quotes: [], claims: [] }]);
  });

  it("parses comma-separated multi-quote drift (the leaked-citation case)", () => {
    const input =
      'Praised for being [[1]](kb:Student-Feedback-at-UNC "enthusiastic", "engaging", "knowledgeable") in class.';
    const { text, citations } = rewriteCitations(input);
    expect(text).toBe("Praised for being [1] in class.");
    expect(citations).toEqual([
      {
        url: "kb:Student-Feedback-at-UNC",
        quotes: ["enthusiastic", "engaging", "knowledgeable"],
        claims: [],
      },
    ]);
  });

  it("tolerates stray extra brackets around the citation number", () => {
    const input =
      'A [[[2]]](https://a.com "quote one"). B [[3]]](kb:CV "quote two").';
    const { text, citations } = rewriteCitations(input);
    expect(text).toBe("A [[1]](https://a.com). B [2].");
    expect(citations).toEqual([
      { url: "https://a.com", quotes: ["quote one"], claims: [] },
      { url: "kb:CV", quotes: ["quote two"], claims: [] },
    ]);
  });

  it("surfaces the quote as visible text when a citation is the payload after a colon", () => {
    const input =
      'The student concluded: [[1]](kb:Student-Feedback "overall an amazing course") And moved on.';
    const { text, citations } = rewriteCitations(input);
    expect(text).toBe(
      'The student concluded: "overall an amazing course" [1] And moved on.'
    );
    expect(citations[0].quotes).toEqual(["overall an amazing course"]);
  });

  it("colon-payload restoration also works for web citations", () => {
    const input = 'It states: [[1]](https://a.com "the exact finding") clearly.';
    const { text } = rewriteCitations(input);
    expect(text).toBe('It states: "the exact finding" [[1]](https://a.com) clearly.');
  });

  it("does not surface quotes for mid-sentence citations", () => {
    const input = 'Praised for [[1]](kb:Feedback "high energy teaching") his energy.';
    const { text } = rewriteCitations(input);
    expect(text).toBe("Praised for [1] his energy.");
  });

  it("parses a quote glued to the URL without a space", () => {
    const input = 'Fact [[1]](https://a.com"tight quote").';
    const { text, citations } = rewriteCitations(input);
    expect(text).toBe("Fact [[1]](https://a.com).");
    expect(citations).toEqual([{ url: "https://a.com", quotes: ["tight quote"], claims: [] }]);
  });
});

describe("claim capture and verification", () => {
  it("captures the sentence preceding a citation as its claim", () => {
    const input =
      "He was recognized as a favorite MBA course instructor by Poets and Quants [[1]](kb:CV-of-the-Owner). Short [[2]](https://a.com).";
    const { citations } = rewriteCitations(input);
    expect(citations[0].claims).toEqual([
      "He was recognized as a favorite MBA course instructor by Poets and Quants",
    ]);
    // "Short" is below the minimum claim length — nothing captured.
    expect(citations[1].claims).toEqual([]);
  });

  it("claimSupported accepts a claim whose significant words are in the source", () => {
    const source =
      "MBA742 was named a favorite MBA course by Poets & Quants in 2024; students praised the instructor.";
    expect(
      claimSupported(
        "He was recognized as a favorite MBA course instructor by Poets and Quants",
        source
      )
    ).toBe(true);
  });

  it("claimSupported rejects a claim about facts the source lacks", () => {
    expect(
      claimSupported(
        "He moved to Vienna University of Economics as Full Professor of Analytics",
        "Student feedback praises his engaging data science teaching at Chapel Hill."
      )
    ).toBe(false);
  });
});

describe("quoteAppearsIn", () => {
  it("matches verbatim quotes despite markdown, case, and whitespace noise", () => {
    const source =
      "He founded **MBA742: Data Science** and\nAI in Business — a favorite course.";
    expect(
      quoteAppearsIn("founded MBA742: Data Science and AI in Business", source)
    ).toBe(true);
  });

  it("tolerates punctuation drift (Ph.D. vs PhD)", () => {
    expect(
      quoteAppearsIn(
        "Ph.D. in Marketing from Goethe University",
        "PhD in Marketing from Goethe University Frankfurt (2017)"
      )
    ).toBe(true);
  });

  it("tolerates light paraphrase via word containment", () => {
    const source =
      "Students consistently praised his engaging teaching style and deep knowledge of data science topics.";
    expect(
      quoteAppearsIn("consistently praised for engaging teaching style", source)
    ).toBe(true);
  });

  it("rejects quotes about facts the source does not contain", () => {
    expect(
      quoteAppearsIn(
        "moved to WU Vienna as Full Professor",
        "CV as of January 2026: Assistant Professor of Marketing at UNC Kenan-Flagler."
      )
    ).toBe(false);
  });

  it("rejects trivially short quotes", () => {
    expect(quoteAppearsIn("a", "a long source text")).toBe(false);
  });
});

describe("kb: citation targets (URL-less knowledge-base sources)", () => {
  it("kbKey slugifies source names", () => {
    expect(kbKey("CV of Jane Doe (Jan 2026)")).toBe(
      "kb:CV-of-Jane-Doe-Jan-2026"
    );
    expect(kbKey("  Teaching Statement  ")).toBe("kb:Teaching-Statement");
  });

  it("renders kb citations as unlinked [N] markers, sharing the numbering", () => {
    const input =
      "Web fact [[1]](https://a.com). KB fact [[2]](kb:Teaching-Statement). Web again [[5]](https://a.com).";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toBe(
      "Web fact [[1]](https://a.com). KB fact [2]. Web again [[1]](https://a.com)."
    );
    expect(orderedUrls).toEqual(["https://a.com", "kb:Teaching-Statement"]);
  });

  it("reuses the same number for repeat kb citations", () => {
    const input = "First [[3]](kb:CV). Later again [[7]](kb:CV).";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toBe("First [1]. Later again [1].");
    expect(orderedUrls).toEqual(["kb:CV"]);
  });

  it("still strips placeholder targets but keeps kb targets", () => {
    const input =
      "Good [[1]](kb:Student-Feedback) but bad [[2]](no URL available).";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toBe("Good [1] but bad.");
    expect(orderedUrls).toEqual(["kb:Student-Feedback"]);
  });
});

describe("wiki-style phrase brackets", () => {
  it("unwraps [[phrase]] without a target to plain text", () => {
    const input = "His article on [[Multimarket Membership Mapping]] [[4]](kb:MMM-Paper), Table 3.";
    const { text } = rewriteCitations(input);
    expect(text).toBe("His article on Multimarket Membership Mapping [1], Table 3.");
  });

  it("converts [[phrase]](http url) to a normal markdown link", () => {
    const input = "He is a [[Full Professor at WU Vienna]](https://linkedin.com/in/jane-doe).";
    const { text, orderedUrls } = rewriteCitations(input);
    expect(text).toBe("He is a [Full Professor at WU Vienna](https://linkedin.com/in/jane-doe).");
    expect(orderedUrls).toEqual([]);
  });

  it("unwraps [[phrase]](kb target) to the plain phrase", () => {
    const input = "Discussed in [[his teaching statement]](kb:Teaching-Statement).";
    const { text } = rewriteCitations(input);
    expect(text).toBe("Discussed in his teaching statement.");
  });

  it("leaves numeric citations untouched by the unwrap", () => {
    const input = "Claim [[2]](https://a.com) stands.";
    const { text } = rewriteCitations(input);
    expect(text).toBe("Claim [[1]](https://a.com) stands.");
  });
});

describe("broken list marker repair", () => {
  it("rejoins a numbered marker left alone on its line with its content", () => {
    const input = "Phases: [[1]](https://a.com)\n\n1.\n**Input Preparation** — build the matrix.\n2.\n**Identification** — cluster.";
    const { text } = rewriteCitations(input);
    expect(text).toContain("1. **Input Preparation** — build the matrix.");
    expect(text).toContain("2. **Identification** — cluster.");
  });

  it("rejoins a bullet marker left alone on its line", () => {
    const input = "-\nFirst point\n-\nSecond point";
    const { text } = rewriteCitations(input);
    expect(text).toBe("- First point\n- Second point");
  });

  it("repairs a marker orphaned by citation-debris stripping", () => {
    const input = "1. [[2]] \n**Input Preparation** — details.";
    const { text } = rewriteCitations(input);
    expect(text).toBe("1. **Input Preparation** — details.");
  });

  it("does not join a marker with a following list marker or heading", () => {
    const input = "1.\n2. Real item\n\n-\n# Heading";
    const { text } = rewriteCitations(input);
    expect(text).toContain("1.\n2. Real item");
    expect(text).toContain("-\n# Heading");
  });

  it("leaves normal lists untouched", () => {
    const input = "1. First item\n2. Second item\n- Bullet one\n- Bullet two";
    const { text } = rewriteCitations(input);
    expect(text).toBe(input);
  });

  it("joins across the marker line even when content starts with bold", () => {
    const input = "3.\n**Transformation** of memberships.";
    const { text } = rewriteCitations(input);
    expect(text).toBe("3. **Transformation** of memberships.");
  });

  it("joins across blank lines that contain whitespace", () => {
    const input = "1. \n \n**Input Preparation** — details.";
    const { text } = rewriteCitations(input);
    expect(text).toBe("1. **Input Preparation** — details.");
  });

  it("handles CRLF line endings", () => {
    const input = "1.\r\n**Input Preparation** — details.";
    const { text } = rewriteCitations(input);
    expect(text).toBe("1. **Input Preparation** — details.");
  });

  it("repairs unicode bullet markers", () => {
    const input = "•\nFirst point\n•\nSecond point";
    const { text } = rewriteCitations(input);
    expect(text).toBe("• First point\n• Second point");
  });
});

describe("rewriteCitationsInParts", () => {
  it("continues numbering across text parts (matches the server's joined pass)", () => {
    const parts = [
      "First finding [[5]](https://a.com).",
      "Later [[1]](https://b.com) and again [[9]](https://a.com).",
    ];
    const rewritten = rewriteCitationsInParts(parts);
    expect(rewritten[0]).toBe("First finding [[1]](https://a.com).");
    expect(rewritten[1]).toBe(
      "Later [[2]](https://b.com) and again [[1]](https://a.com)."
    );
    // Server-side equivalent on the joined text yields the same mapping
    const { orderedUrls } = rewriteCitations(parts.join("\n"));
    expect(orderedUrls).toEqual(["https://a.com", "https://b.com"]);
  });
});

describe("hostnameOf", () => {
  it("extracts hostname without www, empty for junk", () => {
    expect(hostnameOf("https://www.linkedin.com/in/jane-doe/")).toBe("linkedin.com");
    expect(hostnameOf("https://orcid.org/0000-0000-0000-0001")).toBe("orcid.org");
    expect(hostnameOf("not a url")).toBe("");
  });
});
