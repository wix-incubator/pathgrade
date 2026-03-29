import { mockMcpServer } from '../../src/core/mcp-mock';

const navigatorKbResponse = {
  documents: [
    {
      entry: {
        doc_id: 'Rise.ai',
        title: 'Rise.ai',
        content: JSON.stringify({
          description: 'Rise.ai is a gift card and store credit solution that helps businesses boost their sales and customer loyalty through digital gift cards, store credit, and rewards programs. The app seamlessly integrates with Wix, Shopify and other eCommerce platforms.',
          game_plan_link: null,
          kb_id: 'a1803ab5-1ca2-425c-b3d4-bff4a8dc7b0f',
          kb_name: 'domains-kb-rise.ai',
          ownership_tag: 'rise-ai-data',
        }),
      },
      scores_info: { overall_match_score: 0.864 },
    },
    {
      entry: {
        doc_id: 'Online Stores',
        title: 'Online Stores',
        content: JSON.stringify({
          description: 'We provide merchants with the tools they need to offer the best shopping experience on their website, from an attractive storefront to an easy product management dashboard.',
          game_plan_link: 'https://docs.google.com/document/d/1na1G_DrkFUPl8lTDmAT8__Yjzcmah7DH_-OqAH6Y6Lc/edit',
          kb_id: 'acd1a8e4-7d93-4c49-ba79-378f6128dc99',
          kb_name: 'domains-kb-online-stores',
          ownership_tag: 'stores-data',
        }),
      },
      scores_info: { overall_match_score: 0.862 },
    },
  ],
};

const riseAiKbResponse = {
  documents: [
    {
      entry: {
        doc_id: '3',
        title: 'business_kb',
        content: JSON.stringify({
          version: '2025-07-16',
          kb_type: 'business',
          domain: 'rise.ai',
          objects_layer: [
            { name: 'unlock_any_business_full_potential', object_type: 'business_goal', description: 'Help every business build customer relationships to maximize value through engagement.', domain: 'rise.ai' },
            { name: 'manage_all_credit_with_smartwallet', object_type: 'business_goal', description: 'Provide a unified SmartWallet solution for all merchant credit, rewards, refunds, and payments.', domain: 'rise.ai' },
            { name: 'provide_actionable_ai_insights', object_type: 'value_proposition', description: 'Deliver analytics and AI-powered recommendations for segmentation, personalization, lifecycle campaigns.', domain: 'rise.ai' },
            { name: 'automate_credit_and_loyalty', object_type: 'value_proposition', description: 'Enable fully automated, proactive credit rewards and loyalty flows with minimal merchant effort.', domain: 'rise.ai' },
            { name: 'rise_wallet_unified', object_type: 'value_proposition', description: 'Single system to unify store credit, gift cards, refunds, cashback, and loyalty across channels.', domain: 'rise.ai' },
            { name: 'small_medium_merchants', object_type: 'audience_segment', description: 'Ecommerce/retail businesses with $1-10M annual revenue, >1k monthly orders, limited ops/tech resources.', domain: 'rise.ai' },
            { name: 'enterprise_merchants', object_type: 'audience_segment', description: 'Large-scale brands or chains, complex ops, multi-location, need customizable omni-channel loyalty/payment.', domain: 'rise.ai' },
            { name: 'marketing_growth_user', object_type: 'audience_segment', description: 'Brand/product/ecom managers running campaigns to drive revenue, engagement, and retention.', domain: 'rise.ai' },
            { name: 'finance_compliance_user', object_type: 'audience_segment', description: 'CFO, accounting, or finance-focused users who care most about liability, reporting, and accuracy.', domain: 'rise.ai' },
            { name: 'support_storefront_user', object_type: 'audience_segment', description: 'Support/cashiers/frontline team handling issue resolution, credit issuance, and customer delight.', domain: 'rise.ai' },
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
      description: 'Retrieve relevant documents from a knowledge base. Use knowledge_base_id to target a specific domain KB, or use the Navigator KB (10333242-6161-475f-a6b9-1156eda72886) to discover domains.',
      inputSchema: {
        type: 'object',
        properties: {
          knowledge_base_id: { type: 'string', description: 'The knowledge base ID to query' },
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max documents to return' },
        },
        required: ['knowledge_base_id', 'query'],
      },
      when: '10333242-6161-475f-a6b9-1156eda72886',
      response: navigatorKbResponse,
    },
    {
      name: 'retrieve_relevant_documents_from_kb',
      description: 'Retrieve relevant documents from a knowledge base.',
      when: 'a1803ab5-1ca2-425c-b3d4-bff4a8dc7b0f',
      response: riseAiKbResponse,
    },
    {
      name: 'retrieve_relevant_documents_from_kb',
      description: 'Retrieve relevant documents from a knowledge base.',
      response: navigatorKbResponse,
    },
  ],
});
