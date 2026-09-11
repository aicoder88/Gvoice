// Forty representative dictation shapes. These are intentionally synthetic:
// they exercise real usage patterns without copying private customer or owner
// speech into the project. The owner-facing report shows every proposed result
// so punctuation preferences can be approved before a release.

export const CLEANUP_QUALITY_CASES = [
  // 15 ordinary prose dictations
  { category: "prose", name: "two-short-thoughts", input: "this is the first sentence this is the second sentence" },
  { category: "prose", name: "grocery-prose", input: "we need eggs milk bread and butter" },
  { category: "prose", name: "light-filler", input: "so um I think we should uh send this tomorrow", removed: ["um", "uh"] },
  { category: "prose", name: "keep-like", input: "it feels like the right choice for us", kept: ["like"] },
  { category: "prose", name: "keep-you-know", input: "you know this still needs a little polish", kept: ["you", "know"] },
  { category: "prose", name: "keep-sort-of", input: "this is sort of what I had in mind", kept: ["sort", "of"] },
  { category: "prose", name: "simple-comparison", input: "the first version is faster but the second version sounds more natural" },
  { category: "prose", name: "customer-note", input: "the customer ordered yesterday and the package should arrive on Friday" },
  { category: "prose", name: "product-copy", input: "the larger bag gives the customer more value and needs less frequent replacement" },
  { category: "prose", name: "ordinary-comma-list", input: "the page needs a headline a picture a testimonial and a clear button" },
  { category: "prose", name: "short-status", input: "the payment worked and the receipt arrived" },
  { category: "prose", name: "negative-status", input: "the payment failed but the order was not lost" },
  { category: "prose", name: "time-detail", input: "the meeting starts at ten and should finish before noon" },
  { category: "prose", name: "name-preserved", input: "Sarah will send the Purrify samples to Zagreb tomorrow" },
  { category: "prose", name: "long-single-topic", input: "the opening needs more urgency the middle needs stronger proof and the ending needs a clearer reason to buy today" },

  // 8 questions and commands
  { category: "question-command", name: "direct-question", input: "does this work on the installed app", ending: "?" },
  { category: "question-command", name: "why-question", input: "why did the cleanup add so many commas", ending: "?" },
  { category: "question-command", name: "choice-question", input: "should we keep the local choice or use Deepgram", ending: "?" },
  { category: "question-command", name: "send-command", input: "send the revised file to Sarah", ending: "." },
  { category: "question-command", name: "write-command", input: "write a shorter headline for this page", ending: "." },
  { category: "question-command", name: "keep-active-command", input: "fix the punctuation and keep every spoken word", ending: "." },
  { category: "question-command", name: "negative-command", input: "do not change the customer's meaning", ending: "." },
  { category: "question-command", name: "two-part-command", input: "check the price and tell me what changed", ending: "." },

  // 6 spoken corrections
  { category: "correction", name: "replace-item", input: "buy milk no wait buy water", corrected: "buy water" },
  { category: "correction", name: "replace-name", input: "tell John to send it actually tell Sarah to send it", corrected: "tell sarah to send it" },
  { category: "correction", name: "replace-day", input: "the meeting is Tuesday no wait Wednesday at ten", corrected: "the meeting is wednesday at ten" },
  { category: "correction", name: "replace-number", input: "the price is fifty sorry sixty dollars", corrected: "the price is sixty dollars" },
  { category: "correction", name: "i-mean", input: "email Mark I mean email Maya", corrected: "email maya" },
  { category: "correction", name: "scratch-that", input: "use the red version scratch that use the blue version", corrected: "use the blue version" },

  // 5 explicit numbered lists
  { category: "list", name: "first-second-third", input: "my priorities are first speed second accuracy third polish" },
  { category: "list", name: "one-two-three", input: "I need one a headline two a picture three a clear button" },
  { category: "list", name: "steps", input: "the steps are first open the page second check the price third place the order" },
  { category: "list", name: "list-with-wrap", input: "give me first the title second the summary third the price and then send the finished page" },
  { category: "list", name: "four-items", input: "the plan is first review the copy second fix the offer third check the page fourth publish after approval" },

  // 3 Croatian dictations
  { category: "croatian", name: "croatian-status", input: "stranica je spremna ali cijenu treba još jednom provjeriti" },
  { category: "croatian", name: "croatian-question", input: "možemo li poslati novu verziju sutra", ending: "?" },
  { category: "croatian", name: "croatian-command", input: "provjeri narudžbu i javi mi što se promijenilo", ending: "." },

  // 3 mixed Croatian and English dictations
  { category: "mixed", name: "mixed-status", input: "homepage je spreman ali checkout još treba final review" },
  { category: "mixed", name: "mixed-question", input: "možemo li zadržati local model i koristiti Deepgram kao backup", ending: "?" },
  { category: "mixed", name: "mixed-command", input: "provjeri pricing section i onda send the final version", ending: "." }
];
