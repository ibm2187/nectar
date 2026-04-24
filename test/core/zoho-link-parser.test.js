import { describe, it, expect } from 'vitest';

const { parseLinkedZohoTickets } = require('../../src/core/zoho-link-parser');

// Real samples pulled from JIRA's customfield_11157 during feature exploration.
// Kept verbatim so regressions against production data are caught immediately.
const ADF_VHC_4165 = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: '#VHC-4165',
          marks: [
            {
              type: 'link',
              attrs: {
                href: 'https://support.vivtechnologies.com/support/vivtechnologies/ShowHomePage.do#Cases/dv/1078812000011967813',
              },
            },
          ],
        },
      ],
    },
  ],
};

const ADF_BYD_3115 = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: '#BYD-3115',
          marks: [
            { type: 'link', attrs: { href: 'https://support.vivtechnologies.com/support/vivtechnologies/ShowHomePage.do#Cases/dv/1078812000012008034' } },
          ],
        },
      ],
    },
  ],
};

const ADF_PLACEHOLDER = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: '.' }] },
  ],
};

// Two links in the same paragraph, separated by ", "
const ADF_TWO_LINKS_SAME_PARA = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: '#VHC-4165',
          marks: [{ type: 'link', attrs: { href: 'https://support.vivtechnologies.com/a#Cases/dv/1078812000011967813' } }],
        },
        { type: 'text', text: ', ' },
        {
          type: 'text',
          text: '#BYD-3115',
          marks: [{ type: 'link', attrs: { href: 'https://support.vivtechnologies.com/b#Cases/dv/1078812000012008034' } }],
        },
      ],
    },
  ],
};

// Two links across separate paragraphs
const ADF_TWO_PARAS = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: '#VHC-4165', marks: [{ type: 'link', attrs: { href: 'https://x/dv/1078812000011967813' } }] },
      ],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: '#BYD-3115', marks: [{ type: 'link', attrs: { href: 'https://y/dv/1078812000012008034' } }] },
      ],
    },
  ],
};

// Same internal ID appearing twice should dedupe
const ADF_DUPLICATE = {
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: '#VHC-4165', marks: [{ type: 'link', attrs: { href: 'https://x/dv/1078812000011967813' } }] },
        { type: 'text', text: ' see also ' },
        { type: 'text', text: '#VHC-4165', marks: [{ type: 'link', attrs: { href: 'https://y/dv/1078812000011967813' } }] },
      ],
    },
  ],
};

describe('parseLinkedZohoTickets', () => {
  describe('null / empty / junk inputs', () => {
    it('returns empty array for null', () => {
      expect(parseLinkedZohoTickets(null)).toEqual([]);
    });

    it('returns empty array for undefined', () => {
      expect(parseLinkedZohoTickets(undefined)).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      expect(parseLinkedZohoTickets('')).toEqual([]);
    });

    it('returns empty array for { value: null } (Atlassian MCP wrapper)', () => {
      expect(parseLinkedZohoTickets({ value: null })).toEqual([]);
    });

    it('returns empty array for placeholder "." from human-entered junk', () => {
      expect(parseLinkedZohoTickets(ADF_PLACEHOLDER)).toEqual([]);
    });

    it('returns empty array for ADF with no link marks', () => {
      const noLinks = {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'VHC-4165 mentioned inline' }] }],
      };
      expect(parseLinkedZohoTickets(noLinks)).toEqual([]);
    });

    it('returns empty array for link with non-matching URL', () => {
      const wrongUrl = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '#VHC-4165', marks: [{ type: 'link', attrs: { href: 'https://example.com/other' } }] },
            ],
          },
        ],
      };
      expect(parseLinkedZohoTickets(wrongUrl)).toEqual([]);
    });
  });

  describe('ADF single-link parsing', () => {
    it('parses VHC-4165 correctly', () => {
      const result = parseLinkedZohoTickets(ADF_VHC_4165);
      expect(result).toEqual([
        {
          ticketNumber: 'VHC-4165',
          deptPrefix: 'VHC',
          zohoTicketId: '1078812000011967813',
          url: 'https://support.vivtechnologies.com/support/vivtechnologies/ShowHomePage.do#Cases/dv/1078812000011967813',
        },
      ]);
    });

    it('parses BYD-3115 correctly', () => {
      const result = parseLinkedZohoTickets(ADF_BYD_3115);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        ticketNumber: 'BYD-3115',
        deptPrefix: 'BYD',
        zohoTicketId: '1078812000012008034',
      });
    });

    it('unwraps the Atlassian MCP { value: ... } envelope', () => {
      const result = parseLinkedZohoTickets({ value: ADF_VHC_4165 });
      expect(result).toHaveLength(1);
      expect(result[0].ticketNumber).toBe('VHC-4165');
    });
  });

  describe('ADF multi-link parsing', () => {
    it('finds two links in the same paragraph', () => {
      const result = parseLinkedZohoTickets(ADF_TWO_LINKS_SAME_PARA);
      expect(result).toHaveLength(2);
      expect(result.map(r => r.ticketNumber)).toEqual(['VHC-4165', 'BYD-3115']);
    });

    it('finds two links across separate paragraphs', () => {
      const result = parseLinkedZohoTickets(ADF_TWO_PARAS);
      expect(result).toHaveLength(2);
      expect(result.map(r => r.ticketNumber).sort()).toEqual(['BYD-3115', 'VHC-4165']);
    });

    it('deduplicates when the same internal ID appears twice', () => {
      const result = parseLinkedZohoTickets(ADF_DUPLICATE);
      expect(result).toHaveLength(1);
      expect(result[0].zohoTicketId).toBe('1078812000011967813');
    });
  });

  describe('wiki markup fallback', () => {
    it('parses a single wiki link', () => {
      const wiki = '[#VHC-4165|https://support.vivtechnologies.com/support/vivtechnologies/ShowHomePage.do#Cases/dv/1078812000011967813]';
      const result = parseLinkedZohoTickets(wiki);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        ticketNumber: 'VHC-4165',
        deptPrefix: 'VHC',
        zohoTicketId: '1078812000011967813',
      });
    });

    it('parses multiple wiki links separated by text', () => {
      const wiki = 'See [#VHC-4165|https://x/dv/1078812000011967813] and [#BYD-3115|https://y/dv/1078812000012008034]';
      const result = parseLinkedZohoTickets(wiki);
      expect(result).toHaveLength(2);
      expect(result.map(r => r.deptPrefix).sort()).toEqual(['BYD', 'VHC']);
    });

    it('ignores wiki links with non-matching URLs', () => {
      const wiki = '[#VHC-4165|https://example.com/no-dv-path]';
      expect(parseLinkedZohoTickets(wiki)).toEqual([]);
    });
  });

  describe('department prefix coverage', () => {
    it.each([
      ['VHC', '1078812000011967813'],
      ['BYD', '1078812000012008034'],
      ['THC', '1078812000002388927'],
      ['VIV', '1078812000012153003'],
      ['CK',  '1078812000000000001'],
    ])('parses %s-numbered tickets', (prefix, id) => {
      const adf = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [
          { type: 'text', text: `#${prefix}-100`, marks: [{ type: 'link', attrs: { href: `https://x/dv/${id}` } }] },
        ]}],
      };
      const result = parseLinkedZohoTickets(adf);
      expect(result).toHaveLength(1);
      expect(result[0].deptPrefix).toBe(prefix);
      expect(result[0].zohoTicketId).toBe(id);
    });
  });
});
