import { mockMcpServer } from '../../src/core/mcp-mock';

const navigatorKbResponse = {
  documents: [
    {
      entry: {
        doc_id: 'Acme Loyalty',
        title: 'Acme Loyalty',
        content: JSON.stringify({
          description: 'Acme Loyalty is a loyalty and store credit solution that helps merchants boost sales and customer retention through points programs, store credit, and rewards. The module integrates natively with Acme Storefront and other eCommerce platforms.',
          game_plan_link: null,
          kb_id: 'b2904bc6-2db3-536d-c4e0-2267feb83c10',
          kb_name: 'domains-kb-acme-loyalty',
          ownership_tag: 'loyalty-data',
        }),
      },
      scores_info: { overall_match_score: 0.864 },
    },
    {
      entry: {
        doc_id: 'Storefront',
        title: 'Storefront',
        content: JSON.stringify({
          description: 'We provide merchants with the tools they need to offer the best shopping experience on their website, from an attractive storefront to an easy product management dashboard.',
          game_plan_link: 'https://docs.google.com/document/d/1example-storefront-roadmap/edit',
          kb_id: 'c3a15bf5-3ec4-647e-d5f1-3378gfc94d10',
          kb_name: 'domains-kb-storefront',
          ownership_tag: 'storefront-data',
        }),
      },
      scores_info: { overall_match_score: 0.862 },
    },
  ],
};

const loyaltyKbResponse = {
  documents: [
    {
      entry: {
        doc_id: '3',
        title: 'business_kb',
        content: JSON.stringify({
          version: '2025-07-16',
          kb_type: 'business',
          domain: 'acme-loyalty',
          objects_layer: [
            { name: 'increase_repeat_purchases', object_type: 'business_goal', description: 'Help every merchant build customer relationships to maximize lifetime value through engagement and rewards.', domain: 'acme-loyalty' },
            { name: 'unify_credit_management', object_type: 'business_goal', description: 'Provide a unified wallet solution for all merchant credit, rewards, refunds, and store credit.', domain: 'acme-loyalty' },
            { name: 'provide_actionable_ai_insights', object_type: 'value_proposition', description: 'Deliver analytics and AI-powered recommendations for segmentation, personalization, lifecycle campaigns.', domain: 'acme-loyalty' },
            { name: 'automate_loyalty_rewards', object_type: 'value_proposition', description: 'Enable fully automated, proactive loyalty rewards and credit flows with minimal merchant effort.', domain: 'acme-loyalty' },
            { name: 'unified_credit_wallet', object_type: 'value_proposition', description: 'Single system to unify store credit, loyalty points, refunds, cashback, and rewards across channels.', domain: 'acme-loyalty' },
            { name: 'small_medium_merchants', object_type: 'audience_segment', description: 'Ecommerce/retail businesses with $1-10M annual revenue, >1k monthly orders, limited ops/tech resources.', domain: 'acme-loyalty' },
            { name: 'enterprise_merchants', object_type: 'audience_segment', description: 'Large-scale brands or chains, complex ops, multi-location, need customizable omni-channel loyalty/payment.', domain: 'acme-loyalty' },
            { name: 'marketing_growth_user', object_type: 'audience_segment', description: 'Brand/product/ecom managers running campaigns to drive revenue, engagement, and retention.', domain: 'acme-loyalty' },
            { name: 'finance_compliance_user', object_type: 'audience_segment', description: 'CFO, accounting, or finance-focused users who care most about liability, reporting, and accuracy.', domain: 'acme-loyalty' },
            { name: 'support_storefront_user', object_type: 'audience_segment', description: 'Support/cashiers/frontline team handling issue resolution, credit issuance, and customer delight.', domain: 'acme-loyalty' },
          ],
        }),
      },
      scores_info: { overall_match_score: 0.891 },
    },
  ],
};

export const kbRetrievalMock = mockMcpServer({
  name: 'kb-retrieval',
  tools: [
    {
      name: 'retrieve_relevant_documents_from_kb',
      description: 'Retrieve relevant documents from a knowledge base. Use knowledge_base_id to target a specific domain KB, or use the Platform Navigator (20444353-7272-586g-b7ca-2267feb94d97) to discover domains.',
      inputSchema: {
      type: 'object',
      properties: {
          knowledge_base_id: { type: 'string', description: 'The knowledge base ID to query' },
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max documents to return' },
        },
        required: ['knowledge_base_id', 'query'],
      },
      when: '20444353-7272-586g-b7ca-2267feb94d97',
      response: navigatorKbResponse,
    },
    {
      name: 'retrieve_relevant_documents_from_kb',
      description: 'Retrieve relevant documents from a knowledge base.',
      when: 'b2904bc6-2db3-536d-c4e0-2267feb83c10',
      response: loyaltyKbResponse,
    },
    {
      name: 'retrieve_relevant_documents_from_kb',
      description: 'Retrieve relevant documents from a knowledge base.',
      response: navigatorKbResponse,
    },
  ],
});
