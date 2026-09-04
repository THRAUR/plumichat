-- Drop every raw-HTML block and span from a document.
--
-- Used for the PDF export, whose HTML is handed to a headless Chromium. Without
-- this, HTML sitting in an answer's markdown reaches that browser verbatim: an
-- <iframe src="file:///etc/passwd"> really does render the file into the PDF, which
-- would hand a confined member anything the server can read. Disabling pandoc's
-- raw_html extension does NOT prevent it (the gfm/commonmark readers pass HTML
-- blocks through regardless), so the tags are removed here instead — after which the
-- only markup Chromium ever sees is what pandoc itself emitted.
function RawBlock(el)
  return {}
end

function RawInline(el)
  return {}
end
